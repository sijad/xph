import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { build } from '../packages/xph/src/build.js';

it('loads PHP metadata without JSON and matches dependency asset ordering across a diamond graph', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-manifest-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/Leaf.xph'), '<i>Leaf</i><style>i { color: red }</style>');
		for (const name of ['Left', 'Right'])
			await writeFile(
				join(root, `src/${name}.xph`),
				`---\nimport Leaf from './Leaf.xph';\n---\n<section><Leaf /></section><style>section { color: blue }</style>`,
			);
		await writeFile(
			join(root, 'src/Page.xph'),
			`---\nimport Left from './Left.xph';\nimport Right from './Right.xph';\n---\n<main><Left /><Right /></main><style>main { color: green }</style>`,
		);
		await writeFile(join(root, 'src/Empty.xph'), '<p>Empty</p>');
		const result = await build({ root, assetBase: "/assets/it's\\quoted/" });
		expect(result.diagnostics).toEqual([]);
		const directory = join(root, 'dist');
		const output = execFileSync(
			'php',
			[
				'-d',
				'opcache.enable_cli=1',
				'-d',
				'opcache.file_update_protection=0',
				'-r',
				`
require ${JSON.stringify(join(directory, 'xph.php'))};
$directory = ${JSON.stringify(directory)};
$compiled = [];
foreach (array_keys($GLOBALS['xph_manifest']) as $id) {
  if (!array_key_exists($id, $GLOBALS['xph_assets'])) throw new RuntimeException('Missing precomputed assets');
  $compiled[$id] = \\Xph\\assets($id);
}
$html = \\Xph\\render('Page');
$GLOBALS['xph_assets']['stale'] = [];
$GLOBALS['xph_closures']['Page'] = static fn() => 'stale';
rename($directory . '/manifest.json', $directory . '/saved.json');
\\Xph\\configure($directory);
$reset = !isset($GLOBALS['xph_assets']['stale']) && \\Xph\\render('Page') === $html;
$rendered = \\Xph\\render('Page') === $html;
echo json_encode([$compiled, $reset, $rendered]);`,
			],
			{ encoding: 'utf8' },
		);
		const [compiled, reset, sameHtml] = JSON.parse(output);
		expect(compiled.Empty).toEqual([]);
		expect(compiled.Page).toHaveLength(4);
		expect(compiled.Page.map((asset: { url: string }) => asset.url)).toEqual(
			[
				...result.manifest.Leaf.assets,
				...result.manifest.Left.assets,
				...result.manifest.Right.assets,
				...result.manifest.Page.assets,
			].map((asset) => asset.url),
		);
		expect(reset).toBe(true);
		expect(sameHtml).toBe(true);
		await writeFile(join(root, 'src/Page.xph'), '<p>Rebuilt</p>');
		expect((await build({ root })).diagnostics).toEqual([]);
		const rebuilt = execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(join(directory, 'xph.php'))}; echo json_encode([\\Xph\\assets('Page'), \\Xph\\render('Page')]);`,
			],
			{ encoding: 'utf8' },
		);
		expect(JSON.parse(rebuilt)).toEqual([[], '<p>Rebuilt</p>']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
