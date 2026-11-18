import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
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
		await mkdir(join(root, 'dist'));
		await writeFile(join(root, 'dist/manifest.json'), '{}');
		const result = await build({ root, assetBase: "/assets/it's\\quoted/" });
		expect(result.diagnostics).toEqual([]);
		const directory = join(root, 'dist');
		const metadata = await readFile(join(directory, 'manifest.php'), 'utf8');
		expect(metadata).toContain("'assetTable'");
		expect(await readdir(directory)).not.toContain('manifest.json');
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

it('loads frontmatter CSS imports before dependency styles so layer order statements apply first', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-manifest-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(
			join(root, 'src/global.css'),
			'@layer reset, utils;\n@layer reset { b { color: red } }',
		);
		await writeFile(
			join(root, 'src/Button.xph'),
			'<b>Button</b><style>@layer utils { b { color: blue } }</style>',
		);
		await writeFile(
			join(root, 'src/Layout.xph'),
			`---\nimport './global.css';\nimport Button from './Button.xph';\n---\n<main><Button /></main><style>main { color: green }</style>`,
		);
		const result = await build({ root });
		expect(result.diagnostics).toEqual([]);
		const [imported, own] = result.manifest.Layout.assets;
		expect(imported.leading).toBe(true);
		expect(own.leading).toBeUndefined();
		const output = execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(join(root, 'dist/xph.php'))}; echo json_encode(\\Xph\\assets('Layout'));`,
			],
			{ encoding: 'utf8' },
		);
		expect(JSON.parse(output)).toEqual([
			{ type: 'css', url: imported.url },
			...result.manifest.Button.assets,
			{ type: 'css', url: own.url },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('loads the development client with the scripts of every component', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-manifest-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(
			join(root, 'src/Page.xph'),
			'<main>Page</main><script>console.log(1);</script>',
		);
		await writeFile(join(root, 'src/Empty.xph'), '<p>Empty</p>');
		const client = 'http://127.0.0.1:1234/client.js';
		const scripts = () =>
			execFileSync(
				'php',
				[
					'-r',
					`require ${JSON.stringify(join(root, 'dist/xph.php'))};
$r = \\Xph\\renderer(['Page', 'Empty']);
echo $r->scripts();`,
				],
				{ encoding: 'utf8' },
			);
		expect((await build({ root }, { client })).diagnostics).toEqual([]);
		const tags = scripts();
		expect(tags.match(/<script /g)).toHaveLength(2);
		expect(tags).toMatch(new RegExp(`<script type="module" src="${client}"></script>$`));
		expect((await build({ root })).diagnostics).toEqual([]);
		expect(scripts()).not.toContain(client);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
