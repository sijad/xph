import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, compile, type CompileOptions } from '../packages/xph/src/index.js';
import { staticAttribute } from '../packages/xph/src/static-html.js';

function php(code: string): any {
	return JSON.parse(
		execFileSync(
			'php',
			['-r', `require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))}; ${code}`],
			{ encoding: 'utf8' },
		),
	);
}

async function execute(source: string, code: string, options: CompileOptions = {}) {
	const result = await compile(source, { filename: 'Template.xph', ...options });
	expect(result.diagnostics).toEqual([]);
	const directory = await mkdtemp(join(tmpdir(), 'xph-template-'));
	try {
		const file = join(directory, 'component.php');
		await writeFile(file, result.php);
		return php(`$render = require ${JSON.stringify(file)}; ${code}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it.each([false, true])('emits HTML and explicit echo blocks with debug=%s', async (debug) => {
	const result = await compile(
		'---\ninterface Props { title: string }\n---\n<section class="card"><h1>{props.title}</h1></section>',
		{ debug },
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain('?><section class="card"><h1><?php ');
	expect(result.php).toContain('echo \\Xph\\escape(');
	expect(result.php).not.toContain('<?=');
	expect(result.php).not.toContain('$out');
	expect(result.php.includes('$__xph_location')).toBe(debug);
	expect(result.php.includes('recordRuntimeError')).toBe(debug);
	expect(result.php.includes('$__xph_base')).toBe(debug);
	expect(result.mappings.length).toBeGreaterThan(0);
	if (debug) expect(result.php).toMatchSnapshot();
});

it('folds actual constant values, property reads, arithmetic and branches', async () => {
	const source = `---
const config = { title: '<hello>', enabled: true };
const items = ['a', 'b'];
---
<article title={config.title}>{config.enabled ? <b>{config.title}</b> : <i>unused</i>}{items.length + 1}{false && <em>gone</em>}</article>`;
	const result = await compile(source);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain(
		'?><article title="&lt;hello&gt;"><b>&lt;hello&gt;</b>3</article><?php ',
	);
	for (const text of [
		'$constants',
		'\\Xph\\get(',
		'\\Xph\\escape(',
		'\\Xph\\attribute(',
		'unused',
		'<em>',
	])
		expect(result.php).not.toContain(text);
	expect(await execute(source, 'echo json_encode($render([]));')).toBe(
		'<article title="&lt;hello&gt;"><b>&lt;hello&gt;</b>3</article>',
	);
});

it('keeps request values dynamic even when their types are literals', async () => {
	const source = '---\ninterface Props { value: "declared" }\n---\n<p>{props.value}</p>';
	expect(await execute(source, 'echo json_encode($render(["value" => "actual"]));')).toBe(
		'<p>actual</p>',
	);
});

it.each([
	'<a href="java&#x73;cript:alert(1)">unsafe</a>',
	'{false && <a href="javascript:alert(1)">unsafe</a>}',
	'{true ? <p>ok</p> : <iframe srcdoc="unsafe"/>}',
])('validates static attributes before eliminating branches: %s', async (source) => {
	const result = await compile(source);
	expect(
		result.diagnostics.some((d) => /Unsafe URL|Unsupported HTML attribute/.test(d.message)),
	).toBe(true);
});

it('validates unsupported expressions in constant dead branches', async () => {
	const result = await compile('{true ? "ok" : "text".length}');
	expect(result.diagnostics.some((d) => d.message.includes('String length is unsupported'))).toBe(
		true,
	);
});

it('keeps PHP tokens inert inside inline assets and raw constants', async () => {
	const source = `<script is:inline>const token = '<?php $GLOBALS["injected"] = true; ?>';</script><div set:html={'<?php $GLOBALS["injected"] = true; ?>'}/>`;
	const result = await execute(
		source,
		`ob_start(); $html = $render([]); $printed = ob_get_clean(); echo json_encode([$html, $printed, $GLOBALS['injected'] ?? false]);`,
	);
	expect(result).toEqual([
		`<script>const token = '<?php $GLOBALS["injected"] = true; ?>';</script><div><?php $GLOBALS["injected"] = true; ?></div>`,
		'',
		false,
	]);
});

it.each([false, true])(
	'restores caller buffers and retains the failure cause with debug=%s',
	async (debug) => {
		const source = `---
interface Server { fail(): string }
---
<script is:server>
return ['fail' => static function (): string {
  $GLOBALS['original'] = new LogicException('private database details', 17);
  throw $GLOBALS['original'];
}];
</script><p>partial {server.fail()}</p>`;
		const result = await execute(
			source,
			`
\\Xph\\enableRuntimeDiagnostics();
ob_start(); echo 'caller'; $depth = ob_get_level();
$results = [];
for ($i = 0; $i < 2; $i++) {
  try { $render([]); } catch (Throwable $error) {
    $results[] = [get_class($error), $error->getMessage(), $error === $GLOBALS['original'], $error->getPrevious() === $GLOBALS['original'], count(\\Xph\\runtimeDiagnostics($error)), ob_get_level() === $depth];
  }
}
$output = ob_get_clean(); echo json_encode([$results, $output]);`,
			{ debug },
		);
		const expected = debug
			? ['LogicException', 'private database details', true, false, 1, true]
			: ['RuntimeException', 'Render failed for component Template.xph', false, true, 0, true];
		expect(result).toEqual([[expected, expected], 'caller']);
	},
);

it('cleans nested component and slot buffers after production failures', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-template-slots-'));
	try {
		await mkdir(join(directory, 'src'));
		await writeFile(join(directory, 'src/Child.xph'), '<section>child<slot /></section>');
		await writeFile(
			join(directory, 'src/Page.xph'),
			`---
import Child from './Child.xph';
interface Props { fail: boolean }
interface Server { text(): string }
---
<script is:server>
return ['text' => static function () use ($props): string {
  if ($props['fail']) throw new LogicException('private');
  return 'ok';
}];
</script><Child>slot {server.text()}</Child>`,
		);
		const result = await build({ root: directory });
		expect(result.diagnostics).toEqual([]);
		expect(
			php(`\\Xph\\configure(${JSON.stringify(result.outDir)});
ob_start(); $depth = ob_get_level();
try { \\Xph\\render('Page', ['fail' => true]); } catch (Throwable $error) { $message = $error->getMessage(); }
$sameDepth = ob_get_level() === $depth;
$html = \\Xph\\render('Page', ['fail' => false]);
$printed = ob_get_clean();
echo json_encode([$message, $sameDepth, $html, $printed]);`),
		).toEqual([
			'Render failed for component Page.xph',
			true,
			'<section>childslot ok</section>',
			'',
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('matches runtime serialization for static attributes', () => {
	const cases: [string, unknown, string][] = [];
	for (const name of ['title', 'DISABLED', 'ARIA-expanded', 'DATA-ready', 'href', 'src', 'srcset'])
		for (const value of [null, false, true, '', '0', '<&"\'', 0, 1.23456789, 1e-7, 1e21, '/ok'])
			cases.push([name, value, 'img']);
	const expected = php(
		`$cases = json_decode(base64_decode('${Buffer.from(JSON.stringify(cases)).toString('base64')}'), true); echo json_encode(array_map(fn($case) => \\Xph\\attribute(...$case), $cases));`,
	);
	expect(cases.map(([name, value, tag]) => staticAttribute(name, value, tag))).toEqual(expected);
});

it('preserves negative zero and float arguments when folding numbers', async () => {
	const source = `---
interface Server { type(value: number): string }
---
<script is:server>
return ['type' => static fn($value): string => get_debug_type($value)];
</script><p>{1 / -0},{server.type(1 + 2)}</p>`;
	expect(await execute(source, 'echo json_encode($render([]));')).toBe('<p>-Infinity,float</p>');
});

it('preserves build-time call order and snapshots call results before folding constants', async () => {
	const source = `---
const state = { text: 'first', calls: 0 };
const read = () => state;
const mutate = () => { state.text = 'last'; state.calls++; return ''; };
---
<p>{state.text},{read().text},{mutate()},{state.text},{state.calls}</p>`;
	expect(await execute(source, 'echo json_encode($render([]));')).toBe('<p>last,first,,last,1</p>');
});

it('matches runtime URL policy for controls, scheme evasions, image data and URL lists', () => {
	const cases: [string, string, string][] = [];
	for (let code = 0; code <= 32; code++)
		cases.push(['href', String.fromCharCode(code) + 'javascript:alert(1)', 'a']);
	cases.push(
		['href', 'java\tscr\nipt:alert(1)', 'a'],
		['src', 'data:image/png;base64,aGVsbG8=', 'img'],
		['src', 'data:image/svg+xml;base64,aGVsbG8=', 'img'],
		['href', 'data:image/png;base64,aGVsbG8=', 'a'],
		['srcset', '/safe.png 1x, javascript:alert(1) 2x', 'img'],
		['srcset', '/safe.png 1x, /other.png 2x', 'img'],
		['ping', 'https://example.test/\tjavascript:alert(1)', 'a'],
		['href', 'mailto:hello@example.test', 'a'],
	);
	const expected =
		php(`$cases = json_decode(base64_decode('${Buffer.from(JSON.stringify(cases)).toString('base64')}'), true);
echo json_encode(array_map(function ($case) { try { return ['ok', \\Xph\\attribute(...$case)]; } catch (Throwable $error) { return ['error', $error->getMessage()]; } }, $cases));`);
	expect(
		cases.map(([name, value, tag]) => {
			try {
				return ['ok', staticAttribute(name, value, tag)];
			} catch (error) {
				return ['error', (error as Error).message];
			}
		}),
	).toEqual(expected);
});
