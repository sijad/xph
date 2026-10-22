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

it('preserves missing, null, numeric and optional property access in the array fast path', () => {
	expect(
		runtime(`
$undefined = \\Xph\\Undefined::value();
$base = ['missing-looking' => null, 'zero' => 0, 1 => 'one', '01' => 'leading'];
$errors = [];
foreach ([null, $undefined] as $value) {
  try { \\Xph\\get($value, 'key'); } catch (InvalidArgumentException $error) { $errors[] = $error->getMessage(); }
}
echo json_encode([
  \\Xph\\get($base, 'absent') === $undefined,
  \\Xph\\get($base, 'missing-looking'), \\Xph\\get($base, 'zero'),
  \\Xph\\get($base, '1'), \\Xph\\get($base, '01'), \\Xph\\get($base, 1.0),
  \\Xph\\get($base, 1.5) === $undefined, \\Xph\\get($base, INF) === $undefined,
  \\Xph\\get(null, 'key', true) === $undefined,
  \\Xph\\get($undefined, 'key', true) === $undefined, $errors
]);
`),
	).toEqual([
		true,
		null,
		0,
		'one',
		'leading',
		'one',
		true,
		true,
		true,
		true,
		['Property access on a nullish value', 'Property access on a nullish value'],
	]);
});

it.each(['-1', '3'])(
	'formats numbers with serialize_precision=%s and preserves the setting',
	(precision) => {
		expect(
			runtime(`
ini_set('serialize_precision', '${precision}');
$values = [1.23456789, 0.00000123456789, 1.23456789e-7, 1.23456789e21];
$result = array_map('Xph\\numberText', $values);
$result[] = ini_get('serialize_precision');
echo json_encode($result);
`),
		).toEqual(['1.23456789', '0.00000123456789', '1.23456789e-7', '1.23456789e+21', precision]);
	},
);

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

it('collects independently and renders shared dependencies twice while emitting assets once', () => {
	const result = runtime(`
$GLOBALS['runs'] = 0;
$GLOBALS['xph_manifest'] = [
 'C' => ['file'=>'unused', 'dependencies'=>[], 'assets'=>[['type'=>'css','url'=>'/c.css?a="&b=1'], ['type'=>'js','url'=>'/c.js']]],
 'A' => ['file'=>'unused', 'dependencies'=>['C'], 'assets'=>[['type'=>'css','url'=>'/a.css']]],
 'B' => ['file'=>'unused', 'dependencies'=>['C'], 'assets'=>[['type'=>'js','url'=>'/b.js']]],
 'Late' => ['file'=>'unused', 'dependencies'=>[], 'assets'=>[['type'=>'css','url'=>'/late.css'], ['type'=>'js','url'=>'/late.js']]],
 'Script' => ['file'=>'unused', 'dependencies'=>[], 'assets'=>[['type'=>'js','url'=>'/script.js?a="&b=1']]],
];
$GLOBALS['xph_closures']['C'] = static function($props, $slot) { $GLOBALS['runs']++; return 'C'; };
foreach (['A','B'] as $id) $GLOBALS['xph_closures'][$id] = static fn($props, $slot) => \\Xph\\render('C');
$GLOBALS['xph_closures']['Late'] = static function($props, $slot) { $GLOBALS['runs']++; return 'late'; };
$collection = new \\Xph\\AssetCollection();
ob_start(); $collection->prepare('A', 'B'); $output = ob_get_clean();
$initial = $collection->all();
try { $collection->prepare('Late', 'Missing'); } catch (InvalidArgumentException $error) {}
$atomic = $collection->all() === $initial;
$before = $GLOBALS['runs'];
$r = \\Xph\\renderer(['A', 'B']);
$css = $r->styles();
$html = $r->render('A') . $r->render('B');
$js = $r->scripts();
$repeated = [$r->styles(), $r->scripts()];
try { $r->render('Late'); } catch (LogicException $error) { $late = true; }
$afterLate = [$GLOBALS['runs'], $r->scripts()];
$r->prepare('Script');
$script = $r->scripts();
$other = \\Xph\\renderer(['A']);
$empty = \\Xph\\renderer(); $empty->styles();
try { $empty->prepare('A'); } catch (LogicException $error) { $closed = true; }
$collection->prepare('Late');
echo json_encode([$output, $before, $atomic, $initial === $collection->all(), count($initial), $css, $html, $js, $repeated, $late, $afterLate, $script, $other->styles() === $css, $closed, \\Xph\\render('C'), count(\\Xph\\assets('A'))]);
`);
	expect(result).toEqual([
		'',
		0,
		true,
		false,
		4,
		'<link rel="stylesheet" href="/c.css?a=&quot;&amp;b=1"><link rel="stylesheet" href="/a.css">',
		'CC',
		'<script type="module" src="/c.js"></script><script type="module" src="/b.js"></script>',
		['', ''],
		true,
		[2, ''],
		'<script type="module" src="/script.js?a=&quot;&amp;b=1"></script>',
		true,
		true,
		'C',
		3,
	]);
});
