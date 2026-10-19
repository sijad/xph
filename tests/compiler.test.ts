import { describe, it, expect } from 'vitest';
import { compile, build, position, byteOffset, analyzePHP } from '../packages/xph/src/index.js';
import { extractPHP } from '../packages/xph/src/source.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
async function render(source: string, props: unknown = {}, slot = '') {
	const result = await compile(source);
	expect(result.diagnostics).toEqual([]);
	const dir = await mkdtemp(join(tmpdir(), 'xph-test-'));
	try {
		await writeFile(join(dir, 'component.php'), result.php);
		const input = Buffer.from(JSON.stringify(props)).toString('base64');
		return execFileSync(
			'php',
			[
				'-d',
				'display_errors=stderr',
				'-r',
				`require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))}; $render=require ${JSON.stringify(join(dir, 'component.php'))}; echo $render(json_decode(base64_decode('${input}'),true), ${slot ? 'fn() => ' + JSON.stringify(slot) : 'null'});`,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
const front = (props: string, template: string) =>
	`---\nexport interface Props { ${props} }\n---\n${template}`;
describe('real PHP output', () => {
	it('escapes text and attributes without corrupting literals', async () => {
		const value = `"'<&>é😀\\$`;
		const html = await render(
			front(
				'value:string',
				`<p title={props.value}>{props.value}</p><i>back\\slash $dollar 'apostrophe'</i>`,
			),
			{ value },
		);
		expect(html).toBe(
			`<p title="&quot;&#039;&lt;&amp;&gt;é😀\\$">&quot;&#039;&lt;&amp;&gt;é😀\\$</p><i>back\\slash $dollar 'apostrophe'</i>`,
		);
	});
	it('omits nullable/false attributes and preserves zero and empty strings', async () => {
		expect(
			await render(
				front(
					'n:null; b:boolean; z:number; s:string',
					'<input title={props.n} hidden={props.b} value={props.z} class={props.s} aria-expanded={props.b} data-ok={props.b} />',
				),
				{ n: null, b: false, z: 0, s: '' },
			),
		).toBe('<input value="0" class="" aria-expanded="false" data-ok="false">');
	});
	it('renders branches, list callbacks and nullish values', async () => {
		expect(
			await render(
				front(
					'show:boolean; items:string[]; label?:string',
					`{props.show ? <b>yes</b> : <i>no</i>}{props.items.map((item,i)=><p>{i}{item}</p>)}{props.label ?? 'fallback'}`,
				),
				{ show: false, items: ['a', 'b'] },
			),
		).toBe('<i>no</i><p>0a</p><p>1b</p>fallback');
	});
	it('runs PHP once per instance and validates its result', async () => {
		expect(
			await render(
				`---\nexport interface Props {title:string}\nexport interface Server { heading:string }\n---\n<script server lang="php">return ['heading'=>strtoupper($props['title'])];</script><h1>{server.heading}</h1>`,
				{ title: 'hello' },
			),
		).toContain('<h1>HELLO</h1>');
	});
	it('renders default slots and explicit raw HTML', async () => {
		expect(await render('<section><slot>fallback</slot></section>', {}, '<b>slot</b>')).toBe(
			'<section><b>slot</b></section>',
		);
		expect(
			await render(front('html:string', '<div set:html={props.html} />'), { html: '<b>raw</b>' }),
		).toBe('<div><b>raw</b></div>');
	});
	it('preserves JavaScript numeric strict equality', async () =>
		expect(await render(front('n:number', `{props.n === 1 ? 'yes' : 'no'}`), { n: 1.0 })).toBe(
			'yes',
		));
	it('rejects invalid public props in PHP', async () => {
		await expect(render(front('name:string', '{props.name}'), { name: 42 })).rejects.toThrow(
			'Invalid props.name',
		);
	});
});
describe('diagnostics and assets', () => {
	it.each([
		['{props.count && <p/>}', 'count:number', 'Conditions must'],
		["{props.count + 'x'}", 'count:number', 'Addition requires'],
		['{props.name.toUpperCase()}', 'name:string', 'Unsupported expression'],
		['{props.user.name}', 'user?: {name:string}', "possibly 'undefined'"],
		['{props.missing}', '', 'does not exist'],
		['<p onclick={props.name}/>', 'name:string', 'Event-handler'],
		['{props.x}', 'x:any', 'Unsupported contract'],
		['<p {...props}/>', '', 'Unsupported attribute'],
	])('rejects %s', async (template, props, message) => {
		const r = await compile(front(props, template));
		expect(r.diagnostics.some((d) => d.message.includes(message))).toBe(true);
	});
	it('build-time constants stay serializable', async () =>
		expect(await render('---\nconst title = "hello" + " world";\n---\n{title}')).toBe(
			'hello world',
		));
	it('scopes CSS and bundles browser TypeScript', async () => {
		const r = await compile(
			'<p>hi</p><style>p:hover, div > a {color: navy} @keyframes spin {to {opacity:0}}</style><script>const x: number = 1; console.log(x);</script>',
		);
		expect(r.diagnostics).toEqual([]);
		expect(r.assets).toHaveLength(2);
		expect(r.assets[0].content).toMatch(/p\[data-xph-/);
		expect(r.assets[0].content).toContain('to{opacity:0}');
		expect(r.php).toContain('data-xph-');
	});
	it('keeps global styles global', async () => {
		const r = await compile('<style is:global>body { margin:0 }</style>');
		expect(r.assets[0].content).toBe('body{margin:0}\n');
	});
	it('reports a missing PHP executable', async () => {
		const r = await compile('<p/>');
		const d = await analyzePHP(r, { php: '/nonexistent/php' });
		expect(d).toHaveLength(1);
		expect(d[0].source).toBe('php');
		expect(d[0].message).toContain('Install PHP 8.2+');
	});
});
describe('source handling', () => {
	it('skips PHP strings, comments and heredocs with closing tags', () => {
		const s = `<script server lang="php">\r\n$x = '</script>'; /* </script> */\n$x = <<<TXT\n</script>\nTXT;\nreturn [];\n</script><p>é😀</p>`;
		const r = extractPHP(s);
		expect(r.diagnostics).toEqual([]);
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0].code).toContain('return [];');
		expect(Buffer.byteLength(r.masked)).toBe(Buffer.byteLength(s));
		expect(r.masked.length).toBe(s.length);
	});
	it('uses UTF16 LSP positions', () => {
		expect(position('é😀\r\nabc', 6)).toEqual({ line: 1, character: 1 });
		expect(byteOffset('é😀x', 6)).toBe(3);
	});
	it('renders Unicode before an expression with CRLF', async () =>
		expect(
			await render(front('name:string', '<p>é😀{props.name}</p>').replaceAll('\n', '\r\n'), {
				name: '世界',
			}),
		).toBe('<p>é😀世界</p>'));
});
it('builds nested components, captured loop slots and deduplicated assets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-build-'));
	try {
		await writeFile(
			join(root, 'Card.xph'),
			front(
				'title:string',
				'<section>{props.title}<slot/></section><style>section {color: navy}</style>',
			),
		);
		await writeFile(
			join(root, 'Page.xph'),
			`---\nimport Card from './Card.xph';\nexport interface Props { items: string[] }\n---\n{props.items.map(item => <Card title={item}><b>{item}</b></Card>)}<Card title="last"/>`,
		);
		const r = await build({ root, entries: ['Page.xph'] });
		expect(r.diagnostics).toEqual([]);
		const output = execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(join(root, 'dist/xph.php'))}; echo \\Xph\\render('Page',['items'=>['one','two']]); echo count(\\Xph\\assets('Page'));`,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
		expect(output).toContain('<b>one</b>');
		expect(output).toContain('<b>two</b>');
		expect(output.endsWith('1')).toBe(true);
		await writeFile(
			join(root, 'Page.xph'),
			`---\nimport Card from './Card.xph';\n---\n<Card title={42}/>`,
		);
		expect(
			(await build({ root, entries: ['Page.xph'] })).diagnostics.some(
				(d) => d.source === 'typescript',
			),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('distinguishes undefined from null and preserves optional chaining semantics', async () => {
	expect(
		await render(
			front(
				'value?:string|null; user?:{name:string}',
				`{props.value === undefined ? 'absent' : 'present'}{props.value === null ? 'null' : 'other'}{props.user?.name ?? 'fallback'}`,
			),
			{},
		),
	).toBe('absentotherfallback');
	expect(
		await render(
			front(
				'value?:string|null',
				`{props.value === undefined ? 'absent' : 'present'}{props.value === null ? 'null' : 'other'}`,
			),
			{ value: null },
		),
	).toBe('presentnull');
});
it('decodes static attribute entities exactly once', async () =>
	expect(await render('<p title="&quot;&amp;">&amp;</p>')).toBe(
		'<p title="&quot;&amp;">&amp;</p>',
	));
it('rejects implicit server values in browser scripts', async () =>
	expect(
		(await compile('<script>console.log(server.heading)</script>')).diagnostics.some((d) =>
			d.message.includes("Cannot find name 'server'"),
		),
	).toBe(true));
it('maps PHP syntax errors to native source', async () => {
	const r = await compile('<script server lang="php">\nreturn [broken syntax];\n</script>');
	const d = await analyzePHP(r);
	expect(d.some((d) => d.source === 'php' && d.start > 0)).toBe(true);
});
it('preserves lexical loop parameters across nested callbacks', async () =>
	expect(
		await render(
			front(
				'items:string[]',
				`{props.items.map(item => <div>{props.items.map(item => <i>{item}</i>)}{item}</div>)}`,
			),
			{ items: ['a', 'b'] },
		),
	).toBe('<div><i>a</i><i>b</i>a</div><div><i>a</i><i>b</i>b</div>'));
it('does not extract apparent server blocks from template strings', () =>
	expect(extractPHP(`{ "<script server lang='php'>return [];</script>" }`).blocks).toHaveLength(0));
it('preserves fragments', async () =>
	expect(await render('<><b>a</b><i>b</i></>')).toBe('<b>a</b><i>b</i>'));
it('does not leak Unicode-width PHP placeholders into HTML', async () =>
	expect(await render('<script server lang="php">$x="é😀"; return [];</script><p>ok</p>')).toBe(
		'<p>ok</p>',
	));
it('formats JavaScript number results and optional array lengths', async () =>
	expect(
		await render(
			front('items?:string[]', `{1 / 0},{0 / 0},{-0},{1e20},{1e-7},{props.items?.length ?? 0}`),
			{},
		),
	).toBe('Infinity,NaN,0,100000000000000000000,1e-7,0'));

it.each(['server.count.toFixed(2)', 'server.items.at(0)'])(
	'rejects unsupported Server methods: %s',
	async (expression) => {
		const result = await compile(
			`---\nexport interface Server { count: number; items: number[] }\n---\n{${expression}}`,
		);
		expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: 'Unsupported expression: CallExpression.',
				severity: 'error',
			}),
		);
	},
);

it('calls typed PHP Server methods in text, attributes, conditions and loops', async () => {
	expect(
		await render(
			`---
export interface Props { name: string; items: string[] }
export interface Server {
  upper(value: string): string;
  count: (items: string[]) => number;
  isThree(value: number): boolean;
  labels(): string[];
}
---
<script server lang="php">
return [
    'upper' => static fn(string $value): string => strtoupper($value),
    'count' => static fn(array $items): int => count($items),
    'isThree' => static fn(int $value): bool => $value === 3,
    'labels' => static fn(): array => ['a', 'b'],
];
</script>
<h1 title={server.upper(props.name)}>{server.upper(props.name)}</h1>{server.count(props.items)}{server.isThree(3) ? 'yes' : 'no'}{server.labels().map((label) => <b>{server.upper(label)}</b>)}`,
			{ name: '<d>', items: ['x', 'y'] },
		),
	).toContain('<h1 title="&lt;D&gt;">&lt;D&gt;</h1>2yes<b>A</b><b>B</b>');
});

it('keeps returned closures local to each render', async () => {
	expect(
		await render(
			`---
export interface Props { name: string }
export interface Server { greeting(): string }
---
<script server lang="php">
return ['greeting' => static fn(): string => 'Hello ' . $props['name']];
</script>
{server.greeting()}`,
			{ name: 'D' },
		),
	).toContain('Hello D');
});

it.each([
	['upper(3)', "Argument of type 'number'"],
	['upper()', 'Expected 1 arguments'],
	['upper("a", "b")', 'Expected 1 arguments'],
	['missing()', "Property 'missing'"],
])('type checks Server method calls: %s', async (call, message) => {
	const result = await compile(
		`---\nexport interface Server { upper(value: string): string }\n---\n{server.${call}}`,
	);
	expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message))).toBe(true);
});

it.each([
	['Props { run(): string }', 'Functions are supported only'],
	['Server { nested: { run(): string } }', 'required top-level'],
	['Server { run?: () => string }', 'required top-level'],
	['Server { run(value?: string): string }', 'required parameters'],
	['Server { run(...values: string[]): string }', 'required parameters'],
	['Server { run<T>(value: T): string }', 'cannot be generic'],
	['Server { run(): () => string }', 'must be data contracts'],
])('rejects unsupported callable contracts: %s', async (declaration, message) => {
	const result = await compile(`---\nexport interface ${declaration}\n---\n<p/>`);
	expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message))).toBe(true);
});

it.each([
	["'upper' => 'strtoupper'", 'Invalid server.upper: expected function'],
	["'upper' => static fn($value) => 42", 'Invalid server.upper.return: expected string'],
])('validates PHP Server closures and their return values', async (implementation, message) => {
	await expect(
		render(
			`---\nexport interface Server { upper(value: string): string }\n---\n<script server lang="php">return [${implementation}];</script>\n{server.upper('hello')}`,
		),
	).rejects.toThrow(message);
});

it('allows a Server method named map without treating it as an array loop', async () => {
	expect(
		await render(
			`---\nexport interface Server { map(value: string): string }\n---\n<script server lang="php">return ['map' => static fn($value) => strtoupper($value)];</script>{server.map('hello')}`,
		),
	).toBe('HELLO');
});

it.each([
	['[]', 'wrong argument count'],
	['[42]', 'Invalid server.upper.value'],
])('validates Server method arguments at runtime', (argumentsPHP, message) => {
	const schema = Buffer.from(
		JSON.stringify({
			kind: 'object',
			fields: {
				upper: {
					optional: false,
					type: {
						kind: 'function',
						parameters: [{ name: 'value', type: { kind: 'string' } }],
						returns: { kind: 'string' },
					},
				},
			},
		}),
	).toString('base64');
	expect(() =>
		execFileSync(
			'php',
			[
				'-d',
				'display_errors=stderr',
				'-r',
				`require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))}; $schema = json_decode(base64_decode('${schema}'), true); $server = \\Xph\\serverMethods(['upper' => static fn($value) => strtoupper($value)], $schema); $server['upper'](...${argumentsPHP});`,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		),
	).toThrow(message);
});

it('rejects inherited JavaScript methods on Server', async () => {
	const result = await compile('{server.toString()}');
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({ message: 'Only declared Server methods can be called.' }),
	);
});

it('merges server blocks in source order with isolated locals and earlier results', async () => {
	const source = `---
export interface Props { name: string }
export interface Server { label: string; heading: string; calls: number; upper(value: string): string }
---
<script server lang="php">
$local = 'first';
return ['label' => $local, 'calls' => 1, 'upper' => static fn(string $value): string => strtoupper($value)];
</script>
<p>{server.label}</p>
<script server lang="php">
$local = isset($local) ? 'leaked' : 'second';
return ['label' => $local, 'heading' => $server['upper']($props['name']), 'calls' => $server['calls'] + 1];
</script>
<h1>{server.heading}</h1><b>{server.calls}</b><i>{server.upper('hello')}</i>`;
	const html = await render(source, { name: 'world' });
	expect(html).toContain('<p>second</p>');
	expect(html).toContain('<h1>WORLD</h1><b>2</b><i>HELLO</i>');
	expect(html).not.toContain('<script');
});

it('validates the combined Server result after all blocks run', async () => {
	await expect(
		render(
			`---\nexport interface Server { value: string }\n---\n<script server lang="php">return ['value' => 'valid'];</script>\n<script server lang="php">return ['value' => 42];</script>{server.value}`,
		),
	).rejects.toThrow('Invalid server.value');
});

it('maps PHP syntax errors in a later server block to that block', async () => {
	const source =
		'<script server lang="php">return [];</script>\r\n<p>é😀</p>\r\n<script server lang="php">\r\nreturn [broken syntax];\r\n</script>';
	const result = await compile(source);
	expect(result.diagnostics).toEqual([]);
	const diagnostics = await analyzePHP(result);
	expect(diagnostics).toHaveLength(1);
	expect(diagnostics[0].start).toBeGreaterThan(source.indexOf('<script', 1));
	expect(source.slice(diagnostics[0].start, diagnostics[0].end)).toContain('broken syntax');
});
