import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, compile } from '../packages/xph/src/index.js';

function runtime(code: string) {
	return JSON.parse(
		execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))}; \\Xph\\enableRuntimeDiagnostics(); ${code}`,
			],
			{ encoding: 'utf8' },
		),
	);
}

// Transport hostile strings as data, never as PHP source in the test harness.
function phpData(value: unknown): string {
	return `json_decode(base64_decode('${Buffer.from(JSON.stringify(value)).toString('base64')}'), true)`;
}

function html(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]!;
	});
}

async function compiledRuntime(source: string, code: () => string) {
	const result = await compile(source, { debug: true });
	expect(result.diagnostics).toEqual([]);
	const directory = await mkdtemp(join(tmpdir(), 'xph-injection-'));
	try {
		const file = join(directory, 'component.php');
		await writeFile(file, result.php);
		return runtime(`$render = require ${phpData(file)}; ${code()}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it.each([
	'<script>alert(1)</script>',
	'"><img src=x onerror=alert(1)>',
	"' autofocus onfocus='alert(1)",
	'</textarea><svg onload=alert(1)>',
	'</title><script>alert(1)</script>',
	'<!--</style><img src=x onerror=alert(1)>-->',
	'&lt;script&gt;alert(1)&lt;/script&gt;',
	'&#34;&#x3e;<svg/onload=alert(1)>',
])('keeps XSS payloads inert across generated text and attribute contexts: %s', async (value) => {
	const output = await compiledRuntime(
		`---
interface Props { value: string }
---
<p title={props.value}>{props.value}</p><div {...{title: props.value}}/><i class:list={[props.value]}/><textarea>{props.value}</textarea><title>{props.value}</title><svg><text>{props.value}</text></svg><b set:text={props.value}/>{true && <span title={props.value}>{props.value}</span>}`,
		() => `echo json_encode($render(${phpData({ value })}));`,
	);
	const escaped = html(value);
	expect(output).toBe(
		`<p title="${escaped}">${escaped}</p><div title="${escaped}"></div><i class="${escaped}"></i><textarea>${escaped}</textarea><title>${escaped}</title><svg><text>${escaped}</text></svg><b>${escaped}</b><span title="${escaped}">${escaped}</span>`,
	);
});

it.each([
	"'; $GLOBALS['xph_injected'] = true; //",
	"\\'; $GLOBALS['xph_injected'] = true; /*",
	'"; $GLOBALS["xph_injected"] = true; //',
	'${GLOBALS["xph_injected"]}',
	'<?php $GLOBALS["xph_injected"] = true; ?>',
	'<?= $GLOBALS["xph_injected"] = true ?>',
	'`printf xph_injected`',
	"'); phpinfo(); die(); //",
])('never evaluates PHP-looking constants or request values: %s', async (value) => {
	const output = await compiledRuntime(
		`---
const literal = ${JSON.stringify(value)};
const values: Record<string, string> = { [literal]: literal };
interface Props { value: string }
---
<p title={literal}>{literal}</p><b title={props.value}>{props.value}</b><i>{values[props.value]}</i>`,
		() => `
ob_start();
$result = $render(${phpData({ value })});
$printed = ob_get_clean();
echo json_encode([$result, $printed, $GLOBALS['xph_injected'] ?? false]);`,
	);
	const escaped = html(value);
	expect(output).toEqual([
		`<p title="${escaped}">${escaped}</p><b title="${escaped}">${escaped}</b><i>${escaped}</i>`,
		'',
		false,
	]);
});

it('rejects scheme evasions across every C0 prefix and embedded URL whitespace', () => {
	const values = Array.from(
		{ length: 33 },
		(_, code) => String.fromCharCode(code) + 'javascript:alert(1)',
	);
	for (const separator of ['\t', '\r', '\n', '\r\n']) {
		for (let index = 1; index < 'javascript'.length; index++) {
			values.push(
				'javascript'.slice(0, index) + separator + 'javascript'.slice(index) + ':alert(1)',
			);
		}
	}
	expect(
		runtime(`
$results = [];
foreach (${phpData(values)} as $value) {
  try { \\Xph\\attribute('href', $value, 'a'); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
echo json_encode($results);`),
	).toEqual(Array(values.length).fill(true));
});

it.each([
	'<img onerror={props.value}/>',
	'<img ONERROR={props.value}/>',
	'<script>{props.value}</script>',
	'<script is:inline src={props.value}></script>',
	'<style>{props.value}</style>',
	'{true && <img onerror={props.value}/>}',
])('rejects dynamic values in executable output contexts: %s', async (template) => {
	const result = await compile(`---\ninterface Props { value: string }\n---\n${template}`);
	expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
});

it('rejects srcdoc at runtime before returning generated markup', async () => {
	expect(
		await compiledRuntime(
			'---\ninterface Props { value: string }\n---\n<iframe srcdoc={props.value}/>',
			() => `
ob_start();
try { $render(['value' => '<script>alert(1)</script>']); $rejected = false; }
catch (InvalidArgumentException $error) { $rejected = true; }
echo json_encode([$rejected, ob_get_clean()]);`,
		),
	).toEqual([true, '']);
});

it('keeps inline style content literal instead of interpolating request data', async () => {
	expect(
		await compiledRuntime(
			'---\ninterface Props { value: string }\n---\n<style is:inline>{props.value}</style>',
			() => `echo json_encode($render(['value' => '</style><script>alert(1)</script>']));`,
		),
	).toBe('<style>{props.value}</style>');
});

it('resolves request-selected components only through the manifest, never through file paths', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-component-inclusion-'));
	try {
		await writeFile(join(directory, 'Page.xph'), '<p>safe</p>');
		await writeFile(
			join(directory, 'outside.php'),
			"<?php $GLOBALS['xph_injected'] = true; return static fn() => 'injected';",
		);
		const built = await build({ debug: true, root: directory, srcDir: '.' });
		expect(built.diagnostics).toEqual([]);
		const names = [
			'../outside.php',
			'../outside',
			join(directory, 'outside.php'),
			'php://filter/resource=../outside.php',
			'data://text/plain,<?php echo "injected";',
			'Page\u0000/../outside.php',
		];
		expect(
			runtime(`
\\Xph\\configure(${phpData(built.outDir)});
$results = [];
ob_start();
foreach (${phpData(names)} as $name) {
  try { \\Xph\\render($name); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
$printed = ob_get_clean();
echo json_encode([$results, $printed, $GLOBALS['xph_injected'] ?? false, \\Xph\\render('Page')]);`),
		).toEqual([Array(names.length).fill(true), '', false, '<p>safe</p>']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(['href', 'src', 'action', 'formaction', 'data', 'poster', 'xlink:href'])(
	'rejects dangerous URL schemes in %s after browser control normalization',
	(name) => {
		const results = runtime(`
$values = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', " \\x00java\\tscr\\ript:alert(1)\\n", 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload="alert(1)"/>'];
foreach ($values as $value) {
  try { \\Xph\\attribute(${JSON.stringify(name)}, $value, 'a'); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
echo json_encode($results);`);
		expect(results).toEqual([true, true, true, true, true, true]);
	},
);

it('preserves legitimate URLs and escapes entity-shaped strings without decoding them', () => {
	expect(
		runtime(`echo json_encode(array_map(static fn($url) => \\Xph\\attribute('href', $url, 'a'), [
  '/relative?q=a&b=c', '#fragment', '../file', '//example.com/path', 'https://example.com',
  'mailto:a@example.com', 'tel:+123', 'webcal:calendar', 'java&#x73;cript:alert(1)', 'java%73cript:alert(1)'
]));`),
	).toEqual([
		' href="/relative?q=a&amp;b=c"',
		' href="#fragment"',
		' href="../file"',
		' href="//example.com/path"',
		' href="https://example.com"',
		' href="mailto:a@example.com"',
		' href="tel:+123"',
		' href="webcal:calendar"',
		' href="java&amp;#x73;cript:alert(1)"',
		' href="java%73cript:alert(1)"',
	]);
});

it('allows raster image data only in image sources and checks URL lists', () => {
	expect(
		runtime(`
$image = 'data:image/png;base64,aGVsbG8=';
$results = [\\Xph\\attribute('src', $image, 'IMG')];
foreach ([['href', $image, 'a'], ['src', $image, 'iframe'], ['srcset', '/ok.png 1x, javascript:alert(1) 2x', 'img'], ['ping', '/ok javascript:alert(1)', 'a']] as [$name, $value, $tag]) {
  try { \\Xph\\attribute($name, $value, $tag); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
$results[] = \\Xph\\attribute('srcset', '/one.png 1x, /two.png 2x', 'img');
echo json_encode($results);`),
	).toEqual([
		' src="data:image/png;base64,aGVsbG8="',
		true,
		true,
		true,
		true,
		' srcset="/one.png 1x, /two.png 2x"',
	]);
});

it('rejects attribute name injection, event handlers, srcdoc and nonscalar values consistently', () => {
	expect(
		runtime(`
$results = [];
foreach (['onload', 'ONCLICK', 'x" onclick', "href\\n", 'srcdoc'] as $name) {
  foreach ([false, true] as $spread) {
    try { $spread ? \\Xph\\attributes([$name => 'value']) : \\Xph\\attribute($name, 'value'); $results[] = false; }
    catch (InvalidArgumentException $error) { $results[] = true; }
  }
}
foreach ([[], ['nested' => ['value']], new stdClass()] as $value) {
  try { \\Xph\\escape($value); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
  foreach ([false, true] as $spread) {
    try { $spread ? \\Xph\\attributes(['title' => $value]) : \\Xph\\attribute('title', $value); $results[] = false; }
    catch (InvalidArgumentException $error) { $results[] = true; }
  }
}
echo json_encode($results);`),
	).toEqual(Array(19).fill(true));
});

it('substitutes invalid UTF-8, escapes quotes and keeps raw HTML explicit', () => {
	expect(
		runtime(`
$value = "><script>alert(1)</script>\\"'&";
echo json_encode([
  \\Xph\\escape($value), \\Xph\\attribute('title', $value), \\Xph\\attributes(['title' => $value]),
  \\Xph\\escape("\\xff"), \\Xph\\attribute('title', "\\xff"), \\Xph\\attributes(['title' => "\\xff"]), \\Xph\\raw('<b>trusted</b>'),
  \\Xph\\attribute('aria-hidden', false), \\Xph\\attribute('data-ready', true),
  \\Xph\\attribute('hidden', false), \\Xph\\attribute('title', \\Xph\\Undefined::value()),
]);`),
	).toEqual([
		'&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#039;&amp;',
		' title="&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#039;&amp;"',
		' title="&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#039;&amp;"',
		'�',
		' title="�"',
		' title="�"',
		'<b>trusted</b>',
		' aria-hidden="false"',
		' data-ready="true"',
		'',
		'',
	]);
});

it('rejects executable and raw-text dynamic tags including mixed casing', () => {
	expect(
		runtime(`
foreach (['script', 'ScRiPt', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'xmp', 'plaintext', 'noscript', 'noembed', 'noframes', 'div onclick="bad"'] as $tag) {
  try { \\Xph\\elementName($tag); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
$results[] = \\Xph\\elementName('my-card');
echo json_encode($results);`),
	).toEqual([...Array(14).fill(true), 'my-card']);
});

it.each([
	'<a href={props.url}>Open</a>',
	'<a {...props}>Open</a>',
	'{true ? <a href={props.url}>Open</a> : null}',
	'<svg><a href={props.url}>Open</a></svg>',
])('enforces URL policy in generated PHP: %s', async (template) => {
	const result = await compile(
		`---\nexport interface Props { url: string; href: string }\n---\n${template}`,
		{ debug: true },
	);
	expect(result.diagnostics).toEqual([]);
	const directory = await mkdtemp(join(tmpdir(), 'xph-security-'));
	try {
		const file = join(directory, 'component.php');
		await writeFile(file, result.php);
		const output = runtime(`
$render = require ${JSON.stringify(file)};
try { $render(['url' => 'javascript:alert(1)', 'href' => 'javascript:alert(1)']); echo 'false'; }
catch (InvalidArgumentException $error) { echo json_encode([get_class($error), \\Xph\\runtimeDiagnostics($error)[0]['component']]); }`);
		expect(output).toEqual(['InvalidArgumentException', 'component.xph']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('applies URL checks in nested components and on dynamic elements with merged classes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-nested-security-'));
	try {
		await writeFile(
			join(directory, 'Page.xph'),
			`---
import Child from './Child.xph';
export interface Props { url: string; tag: string }
---
<Child url={props.url} tag={props.tag} />`,
		);
		await writeFile(
			join(directory, 'Child.xph'),
			`---
export interface Props { url: string; tag: string }
---
<props.tag src={props.url} class:list={['image', { ready: true }]} />`,
		);
		const built = await build({ debug: true, root: directory, srcDir: '.' });
		expect(built.diagnostics).toEqual([]);
		const result = runtime(`
\\Xph\\configure(${JSON.stringify(built.outDir)});
$results = [\\Xph\\render('Page', ['url' => 'data:image/png;base64,aGVsbG8=', 'tag' => 'img'])];
foreach ([['url' => 'javascript:alert(1)', 'tag' => 'img'], ['url' => '/ok', 'tag' => 'script']] as $props) {
  try { \\Xph\\render('Page', $props); $results[] = false; }
  catch (InvalidArgumentException $error) { $results[] = true; }
}
echo json_encode($results);`);
		expect(result).toEqual([
			'<img src="data:image/png;base64,aGVsbG8=" class="image ready">',
			true,
			true,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('rejects injected computed data attribute names even when their values are escaped', async () => {
	const source = `---
const dataKey = ' onerror=alert(document.location) ';
const dataValue = 'value is escaped';
const imgAttributes = {
  [\`data-\${dataKey}\`]: dataValue,
  src: 'https://testing',
};
---
<img {...imgAttributes} />`;
	const result = await compile(source, { debug: true });
	// A source-located compiler rejection is also safe if the key is statically known.
	if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
		expect(
			result.diagnostics.some((diagnostic) =>
				diagnostic.message.includes('Unsupported spread attribute'),
			),
		).toBe(true);
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), 'xph-attribute-name-'));
	try {
		const file = join(directory, 'component.php');
		await writeFile(file, result.php);
		expect(
			runtime(`
$render = require ${JSON.stringify(file)};
ob_start();
try { $render([]); $result = 'accepted'; }
catch (InvalidArgumentException $error) { $result = $error->getMessage(); }
$output = ob_get_clean();
echo json_encode([$result, $output]);`),
		).toEqual(['Unsupported spread attribute', '']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	' onerror=alert(document.location) ',
	'" onerror=alert(1)',
	'><script>alert(1)</script>',
	'\nONERROR=alert(1)',
])('rejects request-time computed data attribute names: %s', (key) => {
	expect(
		runtime(`
$key = 'data-' . ${JSON.stringify(key)};
try { \\Xph\\attributes([$key => 'value is escaped', 'src' => 'https://testing'], 'img'); echo 'false'; }
catch (InvalidArgumentException $error) { echo 'true'; }`),
	).toBe(true);
});

it.each([
	'" autofocus onfocus="alert(1)',
	"' onmouseover='alert(1)",
	'"><img src=x onerror=alert(1)>',
	'</style><script>alert(1)</script>',
	'&quot;&#34;&lt;script&gt;',
	'url("/image?a=1&b=2")',
])(
	'escapes style object values across native, spread, JSX and static rendering: %s',
	async (value) => {
		const literal = JSON.stringify(value);
		const output = await compiledRuntime(
			`---
interface Props { value: string }
---
<div style={{content: props.value, '--theme': props.value}}/><div {...{style: {content: props.value, '--theme': props.value}}}/>{true ? <span style={{content: props.value, '--theme': props.value}}/> : null}<i style={{content: ${literal}, '--theme': ${literal}}}/>`,
			() => `echo json_encode($render(${phpData({ value })}));`,
		);
		const style = `content:${html(value)};--theme:${html(value)}`;
		expect(output).toBe(
			`<div style="${style}"></div><div style="${style}"></div><span style="${style}"></span><i style="${style}"></i>`,
		);
	},
);

it('escapes hostile CSS property names as well as their values', async () => {
	const key = '--theme"><img src=x onerror=alert(1)>';
	const value = '"<&\'';
	const styles = { [key]: value };
	const output = await compiledRuntime(
		`---
interface Props { styles: { ${JSON.stringify(key)}: string } }
---
<div style={props.styles}/><div {...{style: props.styles}}/><i style={{${JSON.stringify(key)}: ${JSON.stringify(value)}}}/>`,
		() => `echo json_encode($render(${phpData({ styles })}));`,
	);
	const style = `${html(key)}:${html(value)}`;
	expect(output).toBe(
		`<div style="${style}"></div><div style="${style}"></div><i style="${style}"></i>`,
	);
});
