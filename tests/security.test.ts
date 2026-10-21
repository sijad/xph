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
	'<a href="java&#x73;cript:alert(1)">Open</a>',
])('enforces URL policy in generated PHP: %s', async (template) => {
	const result = await compile(
		`---\nexport interface Props { url: string; href: string }\n---\n${template}`,
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
		const built = await build({ root: directory, entries: ['Page.xph'] });
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
	const result = await compile(source);
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
