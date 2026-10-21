import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

it('escapes HTML without runtime contract validators', () => {
	const output = execFileSync(
		'php',
		[
			'-r',
			`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
echo json_encode([
    \\Xph\\escape('<script>"&'),
    function_exists('Xph\\\\validate'),
    function_exists('Xph\\\\serverMethods'),
]);`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual(['&lt;script&gt;&quot;&amp;', false, false]);
});

function runtime(code: string): unknown {
	return JSON.parse(
		execFileSync(
			'php',
			['-r', `require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))}; ${code}`],
			{ encoding: 'utf8' },
		),
	);
}

it('formats numbers independently of serialize_precision and restores the setting', () => {
	expect(
		runtime(`
ini_set('serialize_precision', '3');
$values = [1.23456789, 0.00000123456789, 1.23456789e-7, 1.23456789e21];
$result = array_map('Xph\\numberText', $values);
$result[] = ini_get('serialize_precision');
echo json_encode($result);
`),
	).toEqual(['1.23456789', '0.00000123456789', '1.23456789e-7', '1.23456789e+21', '3']);
});

it('handles attribute casing consistently while preserving the supplied name', () => {
	expect(
		runtime(`echo json_encode([
\\Xph\\attribute('ARIA-expanded', false),
\\Xph\\attribute('DATA-ready', true),
\\Xph\\attribute('DISABLED', true),
\\Xph\\attribute('DISABLED', false),
]);`),
	).toEqual([' ARIA-expanded="false"', ' DATA-ready="true"', ' DISABLED', '']);
});

it('caches dependency assets and clears both caches when configuring another build', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-runtime-'));
	try {
		await writeFile(
			join(directory, 'manifest.json'),
			JSON.stringify({
				Page: {
					file: 'page.php',
					assets: [{ type: 'css', url: '/shared.css' }],
					dependencies: ['Child'],
				},
				Child: {
					file: 'child.php',
					assets: [
						{ type: 'css', url: '/shared.css' },
						{ type: 'js', url: '/child.js' },
					],
					dependencies: [],
				},
			}),
		);
		await writeFile(
			join(directory, 'page.php'),
			'<?php return static fn(array $props, ?callable $slot) => "first";',
		);
		expect(
			runtime(`
\\Xph\\configure(${JSON.stringify(directory)});
$first = \\Xph\\assets('Page');
$render = \\Xph\\render('Page');
$GLOBALS['xph_manifest']['Page']['assets'][] = ['type'=>'css', 'url'=>'/later.css'];
$cached = \\Xph\\assets('Page');
file_put_contents(${JSON.stringify(join(directory, 'page.php'))}, '<?php return static fn(array $props, ?callable $slot) => "second";');
$cachedRender = \\Xph\\render('Page');
\\Xph\\configure(${JSON.stringify(directory)});
echo json_encode([$first, $cached, \\Xph\\assets('Page'), $render, $cachedRender, \\Xph\\render('Page')]);
`),
		).toEqual([
			[
				{ type: 'css', url: '/shared.css' },
				{ type: 'js', url: '/child.js' },
			],
			[
				{ type: 'css', url: '/shared.css' },
				{ type: 'js', url: '/child.js' },
			],
			[
				{ type: 'css', url: '/shared.css' },
				{ type: 'js', url: '/child.js' },
			],
			'first',
			'first',
			'second',
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	['missing', undefined, 'Unable to read'],
	['malformed', '{', 'Invalid xph manifest JSON'],
	['root', '[]', 'Invalid xph manifest structure'],
	['entry', '{"Page":{}}', 'Invalid xph manifest entry'],
	[
		'asset',
		'{"Page":{"file":"page.php","assets":[{}],"dependencies":[]}}',
		'Invalid xph manifest asset',
	],
	[
		'dependency',
		'{"Page":{"file":"page.php","assets":[],"dependencies":[42]}}',
		'Invalid xph manifest dependency',
	],
	[
		'unknown dependency',
		'{"Page":{"file":"page.php","assets":[],"dependencies":["Missing"]}}',
		'Unknown xph manifest dependency',
	],
])(
	'reports %s manifests with their path and preserves the active build',
	async (_, contents, message) => {
		const directory = await mkdtemp(join(tmpdir(), 'xph-runtime-'));
		try {
			if (contents !== undefined) await writeFile(join(directory, 'manifest.json'), contents);
			const result = runtime(`
$GLOBALS['xph_manifest'] = ['existing' => []];
$GLOBALS['xph_assets'] = ['existing' => []];
set_error_handler(static function ($severity, $message) { if (error_reporting() & $severity) throw new \\RuntimeException($message); });
try { \\Xph\\configure(${JSON.stringify(directory)}); }
catch (\\RuntimeException $error) { echo json_encode([$error->getMessage(), $GLOBALS['xph_manifest'], $GLOBALS['xph_assets']]); }
`) as [string, unknown, unknown];
			expect(result[0]).toContain(message);
			expect(result[0]).toContain(join(directory, 'manifest.json'));
			expect(result.slice(1)).toEqual([{ existing: [] }, { existing: [] }]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
