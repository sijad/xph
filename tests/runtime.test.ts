import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { phpLiteral } from '../packages/xph/src/contracts.js';

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
			join(directory, 'manifest.php'),
			'<?php return ' +
				phpLiteral({
					components: {
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
					},
					assets: {
						Page: [
							{ type: 'css', url: '/shared.css' },
							{ type: 'js', url: '/child.js' },
						],
						Child: [
							{ type: 'css', url: '/shared.css' },
							{ type: 'js', url: '/child.js' },
						],
					},
				}) +
				';',
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

it('reports missing PHP manifests and preserves the active build without falling back to JSON', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-runtime-'));
	try {
		await writeFile(join(directory, 'manifest.json'), '{}');
		const result = runtime(`
$GLOBALS['xph_manifest'] = ['existing' => []];
$GLOBALS['xph_assets'] = ['existing' => []];
try { \\Xph\\configure(${JSON.stringify(directory)}); }
catch (\\RuntimeException $error) { echo json_encode([$error->getMessage(), $GLOBALS['xph_manifest'], $GLOBALS['xph_assets']]); }
`) as [string, unknown, unknown];
		expect(result[0]).toContain('Unable to read xph manifest: ' + join(directory, 'manifest.php'));
		expect(result.slice(1)).toEqual([{ existing: [] }, { existing: [] }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

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
$GLOBALS['xph_assets'] = [];
foreach (['C', 'Late', 'Script'] as $id) $GLOBALS['xph_assets'][$id] = $GLOBALS['xph_manifest'][$id]['assets'];
foreach (['A', 'B'] as $id) $GLOBALS['xph_assets'][$id] = array_merge($GLOBALS['xph_assets']['C'], $GLOBALS['xph_manifest'][$id]['assets']);
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

it('validates dynamic element, attribute and spread names as ASCII', () => {
	expect(
		runtime(`
$names = ['a', 'Z9', '_name', 'x:y', 'data-a.b_9', '', '9a', '-a', 'a b', "a\\n", "a\\0", 'é', 'onClick', 'script'];
$result = [];
foreach ($names as $name) {
  $accepted = [];
  foreach (['elementName', 'attribute', 'attributes'] as $operation) {
    try {
      if ($operation === 'elementName') \\Xph\\elementName($name);
      elseif ($operation === 'attribute') \\Xph\\attribute($name, 'value');
      else \\Xph\\attributes([$name => 'value']);
      $accepted[] = true;
    } catch (InvalidArgumentException $error) { $accepted[] = false; }
  }
  $result[] = $accepted;
}
echo json_encode($result);
`),
	).toEqual([
		[true, true, true],
		[true, true, true],
		[false, true, true],
		[true, true, false],
		[true, true, true],
		[false, false, false],
		[false, false, false],
		[false, false, false],
		[false, false, false],
		[false, false, false],
		[false, false, false],
		[false, false, false],
		[true, false, false],
		[false, true, true],
	]);
});
