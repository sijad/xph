import { describe, it, expect } from 'vitest';
import { compile, build, position, byteOffset, analyzePHP } from '../packages/xph/src/index.js';
import type { ScopedStyleStrategy } from '../packages/xph/src/types.js';
import { extractPHP } from '../packages/xph/src/source.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
async function render(
	source: string,
	props: unknown = {},
	slot = '',
	filename?: string,
	compressHTML?: boolean,
	scopedStyleStrategy?: ScopedStyleStrategy,
) {
	const result = await compile(source, { filename, compressHTML, scopedStyleStrategy });
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
	it('omits leading whitespace around frontmatter and server blocks but preserves markup spacing', async () => {
		const source = `---
interface Server { title: string }
---

<script is:server>
return ['title' => 'Hello'];
</script>

<p>{server.title} <b>world</b></p><pre>  indented
  text</pre>`;
		const result = await compile(source);
		expect(result.diagnostics).toEqual([]);
		expect(result.ir[0]).toMatchObject({ kind: 'element', name: 'p' });
		expect(await render(source)).toBe('<p>Hello <b>world</b></p><pre>  indented\n  text</pre>');
	});
	it('compresses only static HTML whitespace by default and supports opting out', async () => {
		const source = front(
			'value: string',
			'<p title="a  b">Hello\n  <b>world</b> \t <i>again</i> {props.value} &nbsp;\u00a0end</p>',
		);
		const props = { value: 'dynamic  \n text' };
		expect(await render(source, props, '', undefined, true)).toBe(
			'<p title="a  b">Hello <b>world</b> <i>again</i> dynamic  \n text &nbsp;\u00a0end</p>',
		);
		expect(await render(source, props)).toBe(await render(source, props, '', undefined, true));
		expect(await render(source, props, '', undefined, false)).toContain('Hello\n  <b>');
	});
	it('preserves sensitive subtrees, comments and inline assets during compression', async () => {
		const source =
			'<pre>  one\n <span>  two\n three</span>{true ? <b>  four\n five</b> : null}</pre><textarea>  six\n seven</textarea><!-- keep  \n comment --><script is:inline>const x = "a  b";\n</script><style is:inline>p { white-space: pre; }\n</style>';
		expect(await render(source)).toBe(await render(source, {}, '', undefined, false));
	});
	it('compresses JSX branches, loops and fragments while preserving explicit expressions', async () => {
		const source = front(
			'items: string[]',
			'{true ? <><b>Hello\n  world</b>{"  "}</> : <i>no</i>}{props.items.map(item => <p> item:  {item}</p>)}',
		);
		expect(await render(source, { items: ['a  b'] }, '', undefined, true)).toBe(
			'<b>Hello world</b>  <p> item: a  b</p>',
		);
	});
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
	it('spreads attributes in templates and JSX with ordered overrides and escaping', async () => {
		const source = front(
			'show:boolean; attrs:{title:string; hidden:boolean; "data-ok":boolean; value:number; label?:string}',
			'<input title="before" {...props.attrs} value="after" />{props.show ? <input {...props.attrs} title="last" /> : null}',
		);
		expect(
			await render(source, {
				show: true,
				attrs: { title: '<&"', hidden: false, 'data-ok': false, value: 0 },
			}),
		).toBe(
			'<input title="&lt;&amp;&quot;" data-ok="false" value="after"><input title="last" data-ok="false" value="0">',
		);
	});
	it('merges multiple spreads and allows later nullish values to remove attributes', async () => {
		expect(
			await render(
				front(
					'title:string; hidden:boolean',
					'<p { ...props } {...{title:null, hidden:false}} id="last" />',
				),
				{ title: 'before', hidden: true },
			),
		).toBe('<p id="last"></p>');
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
	it('flattens class lists, applies JavaScript truthiness and escapes the result', async () => {
		expect(
			await render(
				front(
					'active:boolean; label:string',
					`<div class="base" class:list={['hello', { active: props.active, zero: '0', empty: '', array: [] }, ['friend', false, null, undefined, 0, 2], props.label]} />`,
				),
				{ active: true, label: '<&"' },
			),
		).toBe('<div class="base hello active zero array friend 2 &lt;&amp;&quot;"></div>');
		expect(await render('<div class:list={[false, null, undefined, 0]} />')).toBe('<div></div>');
	});
	it('supports class lists inside JSX expressions and alongside spreads', async () => {
		expect(
			await render(
				front(
					'active:boolean; css:string',
					`{props.active ? <div class:list={['extra', {active: props.active}]} {...{class: props.css}} /> : null}`,
				),
				{ active: true, css: 'base' },
			),
		).toBe('<div class="base extra active"></div>');
		expect(await render('<div class:list={["extra"]} class="base" />')).toBe(
			'<div class="base extra"></div>',
		);
	});
	it('preserves numeric class keys in object literals', async () => {
		expect(await render(`<div class:list={[{'0': true, '1': false}, '0']} />`)).toBe(
			'<div class="0 0"></div>',
		);
	});
	it('passes a normalized class prop to imported components', async () => {
		const result = await compile(
			`---\nimport Card from './Card.xph';\n---\n<Card class="base" class:list={['extra']} />`,
			{
				components: {
					Card: {
						id: 'Card',
						props: {
							kind: 'object',
							fields: { class: { type: { kind: 'string' }, optional: true } },
						},
					},
				},
			},
		);
		expect(result.diagnostics).toEqual([]);
		expect(result.php).toContain('\\Xph\\classProps(');
	});
	it('runs PHP once per instance', async () => {
		expect(
			await render(
				`---\nexport interface Props {title:string}\nexport interface Server { heading:string }\n---\n<script is:server>return ['heading'=>strtoupper($props['title'])];</script><h1>{server.heading}</h1>`,
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
	it('renders set:text as escaped text in templates and JSX expressions', async () => {
		const value = '<b>"hello" & goodbye</b>';
		const expected = '<div>&lt;b&gt;&quot;hello&quot; &amp; goodbye&lt;/b&gt;</div>';
		expect(await render(front('value:string', '<div set:text={props.value} />'), { value })).toBe(
			expected,
		);
		expect(
			await render(front('value:string', '{true ? <div set:text={props.value} /> : null}'), {
				value,
			}),
		).toBe(expected);
		expect(await render('<p set:text="&lt;b&gt;" />')).toBe('<p>&lt;b&gt;</p>');
		expect(await render('<p set:text={0} /><p set:text={null} /><p set:text={false} />')).toBe(
			'<p>0</p><p></p><p></p>',
		);
	});
	it.each([
		['<div set:text="value">child</div>', 'cannot have children'],
		['{true ? <div set:text="value">child</div> : null}', 'cannot have children'],
		['<div set:text="value" set:html="html" />', 'cannot be combined'],
		['{true ? <div set:html="html" set:text="value" /> : null}', 'cannot be combined'],
		['<slot set:text="value" />', 'requires an HTML element'],
		['<div set:text={["value"]} />', 'Only scalar values'],
		['<script set:text="value" />', 'Unsupported asset attribute'],
		['<style set:text="value" />', 'Unsupported asset attribute'],
		[
			`---\nimport Card from './Card.xph';\n---\n<Card set:text="value" />`,
			'requires an HTML element',
		],
	])('rejects invalid set:text usage: %s', async (source, message) => {
		const result = await compile(source);
		expect(result.diagnostics.some((d) => d.message.includes(message))).toBe(true);
	});
	it('preserves JavaScript numeric strict equality', async () =>
		expect(await render(front('n:number', `{props.n === 1 ? 'yes' : 'no'}`), { n: 1.0 })).toBe(
			'yes',
		));
	it('uses props without runtime contract validation', async () => {
		expect(await render(front('name:string', '{props.name}'), { name: 42 })).toBe('42');
	});
});
describe('diagnostics and assets', () => {
	it('evaluates imported function calls with build-time arguments in text, attributes and branches', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-calls-'));
		try {
			await writeFile(
				join(root, 'text.ts'),
				`
export function formatLabel(value: string): string { return '<' + value + '>'; }
export function enabled(): boolean { return true; }
export function items(): string[] { return ['one', 'two']; }
`,
			);
			expect(
				await render(
					`---
import { formatLabel, enabled, items } from './text';
const label = 'hello';
const labels = ['static'];
---
<div title={formatLabel(label)}>{formatLabel('world')}</div>{enabled() ? <b>yes</b> : <i>no</i>}{items().map(item => <p>{item}</p>)}{labels.map(item => <i>{item}{formatLabel('constant')}</i>)}`,
					{},
					'',
					join(root, 'index.xph'),
				),
			).toBe(
				'<div title="&lt;hello&gt;">&lt;world&gt;</div><b>yes</b><p>one</p><p>two</p><i>static&lt;constant&gt;</i>',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('evaluates local functions in the same build-time scope as frontmatter', async () => {
		expect(
			await render(`---
const counter = { value: 0 };
const values = ['a'];
function next() { return ++counter.value; }
function twice(value: number) { return value * 2; }
---
{next()}{twice(next())}{next()}{values.map(value => next())}`),
		).toBe('1434');
	});
	it.each([
		['stringifyValue(props.name)', 'name:string'],
		['stringifyValue({ props })', 'name:string'],
		['stringifyValue(server.name)', ''],
		['props.items.map(item => <p>{stringifyValue(item)}</p>)', 'items:string[]'],
		['props.items.map(item => <p>{stringifyValue({ item })}</p>)', 'items:string[]'],
		['props.items.map(stringifyValue => <p>{stringifyValue.toUpperCase()}</p>)', 'items:string[]'],
	])('does not evaluate request-time calls: %s', async (expression, props) => {
		const result = await compile(`---
interface Props { ${props} }
interface Server { name: string }
function stringifyValue(value: unknown = '') { throw new Error('must not execute'); return String(value); }
---
{${expression}}`);
		expect(
			result.diagnostics.some((d) => d.message.includes('Unsupported expression: CallExpression')),
		).toBe(true);
		expect(result.diagnostics.some((d) => d.message.includes('must not execute'))).toBe(false);
	});
	it.each([
		['throw new Error("broken")', 'broken'],
		['return (() => 1) as unknown as string', 'serializable'],
		['return Promise.resolve("later") as unknown as string', 'serializable'],
		['const value: any = {}; value.self = value; return value', 'serializable'],
	])('maps build-time evaluation failures to their calls: %s', async (body, message) => {
		const source = `---\nfunction createValue(): string { ${body}; }\n---\n{createValue()}`;
		const result = await compile(source);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining(message),
				start: source.lastIndexOf('createValue()'),
				end: source.lastIndexOf('createValue()') + 'createValue()'.length,
			}),
		);
	});
	it('keeps JSX intrinsic types available with frontmatter imports', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-jsx-'));
		try {
			await writeFile(join(root, 'title.ts'), "export const title = 'Title';");
			const result = await compile(
				`---
import { title } from './title';
interface Props { show: boolean }
---
{props.show ? <section><h1>{title}</h1></section> : <slot />}`,
				{ filename: join(root, 'index.xph') },
			);
			expect(result.diagnostics).toEqual([]);
			expect(result.php).toContain('<section');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		['{props.count && <p/>}', 'count:number', 'Conditions must'],
		["{props.count + 'x'}", 'count:number', 'Addition requires'],
		['{props.name.toUpperCase()}', 'name:string', 'Unsupported expression'],
		['{props.user.name}', 'user?: {name:string}', "possibly 'undefined'"],
		['{props.missing}', '', 'does not exist'],
		['<p onclick={props.name}/>', 'name:string', 'Event-handler'],
		['{props.x}', 'x:any', 'Unsupported contract'],
		['<p {...props.name}/>', 'name:string', 'Spread attributes require an object'],
		['<p {...props}/>', 'onclick:string', 'Unsupported spread attribute'],
		['{true ? <p {...props}/> : null}', 'onclick:string', 'Unsupported spread attribute'],
		['<p {...props}/>', 'nested:{value:string}', 'Only scalar values'],
		['<p {...props.items}/>', 'items:string[]', 'Spread attributes require an object'],
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
	it('renders inline scripts and styles verbatim without extracting assets', async () => {
		const source = `<div>hi</div><script is:inline type="module">import './local.js'; const value = { raw: true };</script><style is:inline media="screen">div { color: navy } @keyframes spin { to { opacity: 0 } }</style>`;
		const r = await compile(source);
		expect(r.diagnostics).toEqual([]);
		expect(r.assets).toEqual([]);
		expect(await render(source)).toBe(source.replaceAll(' is:inline', ''));
	});
	it('preserves external inline scripts and repeats inline content', async () => {
		const script = '<script src="/browser.js" is:inline defer></script>';
		expect(await render(script + script)).toBe((script + script).replaceAll(' is:inline', ''));
	});
	it('keeps inline styles raw alongside scoped bundled styles', async () => {
		const r = await compile(
			'<p>hi</p><style>p { color: red }</style><style is:inline>p { color: blue }</style>',
		);
		expect(r.diagnostics).toEqual([]);
		expect(r.assets).toHaveLength(1);
		expect(r.assets[0].content).toMatch(/p\[data-xph-/);
		expect(r.php).toContain('<style>p { color: blue }</style>');
	});
	it('rejects runtime inline asset attributes', async () => {
		const r = await compile(front('url:string', '<script is:inline src={props.url}></script>'));
		expect(r.diagnostics.some((d) => d.message.includes('Runtime interpolation'))).toBe(true);
	});
	it('reports a missing PHP executable', async () => {
		const r = await compile('<p/>');
		const d = await analyzePHP(r, { php: '/nonexistent/php' });
		expect(d).toHaveLength(1);
		expect(d[0].source).toBe('php');
		expect(d[0].message).toContain('Install PHP 8.0+');
	});
});
describe('source handling', () => {
	it('skips PHP strings, comments and heredocs with closing tags', () => {
		const s = `<script is:server>\r\n$x = '</script>'; /* </script> */\n$x = <<<TXT\n</script>\nTXT;\nreturn [];\n</script><p>é😀</p>`;
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
			`---\nimport Card from './Card.xph';\nexport interface Props { items: string[] }\n---\n{props.items.map(item => <Card {...{title: item}}><b>{item}</b></Card>)}<Card {...{title: "before"}} title="last"/>`,
		);
		const r = await build({ root, srcDir: '.' });
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
			`---\nimport Card from './Card.xph';\n---\n<Card {...{title: 42}}/>`,
		);
		expect(
			(await build({ root, srcDir: '.' })).diagnostics.some((d) => d.source === 'typescript'),
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
it('uses the same undefined sentinel for literals and missing values', async () => {
	const result = await compile('{undefined}');
	expect(result.php).not.toContain('\\Xph\\Undefined::value()');
	expect(
		await render(
			front(
				'value?:string',
				`{undefined === undefined ? 'same' : 'different'}<p title={undefined}>{undefined}{props.value ?? 'fallback'}</p>`,
			),
		),
	).toBe('same<p>fallback</p>');
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
	const r = await compile('<script is:server>\nreturn [broken syntax];\n</script>');
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
	expect(extractPHP(`{ "<script is:server>return [];</script>" }`).blocks).toHaveLength(0));
it('preserves fragments', async () =>
	expect(await render('<><b>a</b><i>b</i></>')).toBe('<b>a</b><i>b</i>'));
it('does not leak Unicode-width PHP placeholders into HTML', async () =>
	expect(await render('<script is:server>$x="é😀"; return [];</script><p>ok</p>')).toBe(
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
<script is:server>
return [
    'upper' => static fn(string $value): string => strtoupper($value),
    'count' => static fn(array $items): int => count($items),
    'isThree' => static fn(int|float $value): bool => $value == 3,
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
<script is:server>
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
	["'upper' => 'strtoupper'", 'HELLO'],
	["'upper' => static fn($value) => 42", '42'],
])(
	'calls PHP Server implementations without contract wrappers',
	async (implementation, message) => {
		await expect(
			render(
				`---\nexport interface Server { upper(value: string): string }\n---\n<script is:server>return [${implementation}];</script>\n{server.upper('hello')}`,
			),
		).resolves.toBe(message);
	},
);

it('allows a Server method named map without treating it as an array loop', async () => {
	expect(
		await render(
			`---\nexport interface Server { map(value: string): string }\n---\n<script is:server>return ['map' => static fn($value) => strtoupper($value)];</script>{server.map('hello')}`,
		),
	).toBe('HELLO');
});

it('rejects inherited JavaScript methods on Server', async () => {
	const result = await compile('{server.toString()}');
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({ message: 'Only declared Server methods can be called.' }),
	);
});

it('rejects additional server scripts at their opening tags', async () => {
	const source =
		'<script is:server>return [];</script>\r\n<p>é😀</p>\r\n<script is:server>return [];</script>\n<script is:server>return [];</script>';
	const result = await compile(source);
	const second = source.indexOf('<script', 1);
	const third = source.indexOf('<script', second + 1);
	expect(result.diagnostics).toEqual(
		[second, third].map((start) => ({
			message: 'Only one server script is allowed per component.',
			severity: 'error',
			source: 'xph',
			start,
			end: source.indexOf('>', start) + 1,
		})),
	);
	expect(result.php).toBe('');
});

it('uses the Server result without runtime validation', async () => {
	await expect(
		render(
			`---\nexport interface Server { value: string }\n---\n<script is:server>return ['value' => 42];</script>{server.value}`,
		),
	).resolves.toBe('42');
});

it('inherits Server methods and data through multiple local contract bases', async () => {
	expect(
		await render(`---
interface Helpers { upper(value: string): string }
interface Shared extends Helpers { label: string }
type Count = { count: number };
export interface Server extends Shared, Count { heading: string }
---
<script is:server>
return ['upper' => static fn(string $value): string => strtoupper($value), 'label' => 'hello', 'count' => 2, 'heading' => '!'];
</script><p>{server.upper(server.label)}{server.count}{server.heading}</p>`),
	).toBe('<p>HELLO2!</p>');
});

it.each([
	['interface A extends Server {} export interface Server extends A {}', 'Recursive contract'],
	['export interface Server extends Missing {}', 'Unknown contract Missing'],
	['type Base = string; export interface Server extends Base {}', 'Contract bases must be object'],
	[
		'interface A { value: string } interface B { value: number } export interface Server extends A, B {}',
		'Conflicting inherited',
	],
	[
		'interface Base { nested: { method(): string } } export interface Server extends Base {}',
		'required top-level',
	],
])('rejects invalid inherited contracts: %s', async (declarations, message) => {
	const result = await compile(`---\n${declarations}\n---\n<p />`);
	expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message))).toBe(true);
});

it('calls inherited Server methods without runtime validation', async () => {
	await expect(
		render(`---
interface Base { upper(value: string): string }
export interface Server extends Base {}
---
<script is:server>return ['upper' => static fn($value) => 42];</script>
{server.upper('hello')}`),
	).resolves.toBe('42');
});

it('resolves imported mapped and conditional contracts from field definitions', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'xph-contract-'));
	try {
		const packageDir = join(dir, 'node_modules', 'acf-generator');
		await mkdir(packageDir, { recursive: true });
		await writeFile(
			join(packageDir, 'package.json'),
			JSON.stringify({
				name: 'acf-generator',
				exports: { '.': { types: './index.d.ts' } },
			}),
		);
		await writeFile(
			join(packageDir, 'index.d.ts'),
			`
export type FieldsToObject<T extends readonly { name: string; type: string }[]> = {
  [F in T[number] as F['name']]: F['type'] extends 'text' ? string : number;
};`,
		);
		await writeFile(
			join(dir, 'hero.fields.ts'),
			`
export const heroFields = [{ name: 'title', type: 'text' }, { name: 'count', type: 'number' }] as const;`,
		);
		const source = `---
import type { FieldsToObject } from 'acf-generator';
import { heroFields } from './hero.fields';
export interface Server { fields: FieldsToObject<typeof heroFields> }
---
<script is:server>return ['fields' => ['title' => 'Hello', 'count' => 3]];</script>
<h1>{server.fields.title}</h1><p>{server.fields.count + 1}</p>`;
		expect(await render(source, {}, '', join(dir, 'Hero.xph'))).toBe('<h1>Hello</h1><p>4</p>');
		const result = await compile(source, { filename: join(dir, 'Hero.xph'), contractsOnly: true });
		expect(result.diagnostics).toEqual([]);
		expect(result.server).toEqual({
			kind: 'object',
			fields: {
				fields: {
					optional: false,
					type: {
						kind: 'object',
						fields: {
							title: { optional: false, type: { kind: 'string' } },
							count: { optional: false, type: { kind: 'number' } },
						},
					},
				},
			},
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it('rejects unresolved imported contract types instead of accepting any', async () => {
	const result = await compile(`---
import type { Missing } from './does-not-exist';
export interface Server { fields: Missing }
---
{server.fields.title}`);
	expect(result.diagnostics.some((d) => d.message.includes('Unsupported contract:'))).toBe(true);
});

it('emits PHPDoc contracts without runtime schemas or validation wrappers', async () => {
	const result = await compile(`---
export interface Props { title: string }
export interface Server { upper(value: string): string }
---
<script is:server>return ['upper' => static fn($value) => strtoupper($value)];</script>
{server.upper(props.title)}`);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain('@param array{"title": string} $props');
	expect(result.php).toContain('@var array{"upper": \\Closure(string): string} $server');
	expect(result.php).not.toContain('\\Xph\\validate');
	expect(result.php).not.toContain('\\Xph\\serverMethods');
	expect(result.php).not.toContain("'kind' =>");
});

it('resolves local generic contract bases', async () => {
	expect(
		await render(`---
interface Base<T> { value: T }
export interface Server extends Base<string> {}
---
<script is:server>return ['value' => 'hello'];</script>{server.value}`),
	).toBe('hello');
});

it('erases symbol-only primitive brands from runtime contracts', async () => {
	const source = `---
declare const phpFunction: unique symbol;
type PhpFunction<T> = string & { readonly [phpFunction]: T };
export interface Props { field: PhpFunction<{ title: string }> }
---
<p>{props.field}</p>`;
	const result = await compile(source, { contractsOnly: true });
	expect(result.diagnostics).toEqual([]);
	expect(result.props).toEqual({
		kind: 'object',
		fields: {
			field: { optional: false, type: { kind: 'string' } },
		},
	});
});

it('does not erase runtime members from primitive intersections', async () => {
	const result = await compile(
		`---
export interface Props { field: string & { value: string } }
---`,
		{ contractsOnly: true },
	);
	expect(result.props).not.toEqual({
		kind: 'object',
		fields: {
			field: { optional: false, type: { kind: 'string' } },
		},
	});
});

describe('dynamic element names', () => {
	it('renders a frontmatter tag with attributes and children', async () => {
		expect(await render('---\nconst A = \'div\';\n---\n<A class="box">My Div</A>')).toBe(
			'<div class="box">My Div</div>',
		);
	});
	it('supports tags inside expressions and loops', async () => {
		expect(
			await render("---\nconst tags = ['div', 'span'];\n---\n{tags.map(A => <A><A>text</A></A>)}"),
		).toBe('<div><div>text</div></div><span><span>text</span></span>');
	});
	it('omits closing tags for dynamic void elements', async () => {
		expect(await render("---\nconst A: string = 'input';\n---\n<A disabled />")).toBe(
			'<input disabled>',
		);
	});
	it('supports runtime member expressions', async () => {
		expect(
			await render(front('tag: string', '<props.tag>hello</props.tag>'), { tag: 'section' }),
		).toBe('<section>hello</section>');
	});
	it('rejects non-string names', async () => {
		const result = await compile('---\nconst A = 42;\n---\n<A />');
		expect(result.diagnostics.some((d) => d.message.includes('must have string type'))).toBe(true);
	});
	it.each(['div onclick="bad"', '', '><script'])('rejects invalid tag %j', async (tag) => {
		await expect(render(front('tag: string', '<props.tag />'), { tag })).rejects.toThrow(
			'Invalid dynamic element name',
		);
	});
});

it('preserves valid sibling IR when a template node cannot be lowered', async () => {
	const result = await compile('<p>before</p><Missing/><p>after</p>');
	expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
	expect(result.ir).toMatchObject([
		{ kind: 'element', name: 'p', children: [{ kind: 'text', value: 'before' }] },
		{ kind: 'element', name: 'p', children: [{ kind: 'text', value: 'after' }] },
	]);
});
it('renders named and default slots with fallbacks and parent loop captures', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-slots-'));
	try {
		await writeFile(
			join(root, 'Card.xph'),
			'<header><slot name="header">heading</slot></header><main><slot>body</slot></main><footer><slot name="footer">foot</slot></footer>',
		);
		await writeFile(join(root, 'Label.xph'), '<strong>label</strong>');
		await writeFile(
			join(root, 'Page.xph'),
			`---
import Card from './Card.xph';
import Label from './Label.xph';
export interface Props { items: string[] }
---
<Card><Fragment slot="header"><b>first</b><Label/></Fragment><p>default</p></Card>{props.items.map(item => <Card><Fragment slot="header"><i>{item}</i></Fragment><span slot="footer">{item}</span></Card>)}<Card/>`,
		);
		const result = await build({ root, srcDir: '.' });
		expect(result.diagnostics).toEqual([]);
		const output = execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(join(root, 'dist/xph.php'))}; echo \\Xph\\render('Page', ['items'=>['one','two']]);`,
			],
			{ encoding: 'utf8' },
		);
		expect(output).toBe(
			'<header><b>first</b><strong>label</strong></header><main><p>default</p></main><footer>foot</footer><header><i>one</i></header><main>body</main><footer><span>one</span></footer><header><i>two</i></header><main>body</main><footer><span>two</span></footer><header>heading</header><main>body</main><footer>foot</footer>',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it.each([
	'<slot name={"header"}/>',
	'<slot name=""/>',
	'<slot other="header"/>',
	'<div slot="header"/>',
	'{true && <slot name={"header"}/>}',
])('rejects invalid slot syntax: %s', async (source) => {
	expect((await compile(source)).diagnostics.some((d) => d.severity === 'error')).toBe(true);
});

it('renders explicit fragments without wrappers in markup and expressions', async () => {
	expect(
		await render('<Fragment><b>one</b><Fragment><i>two</i></Fragment></Fragment><Fragment/>'),
	).toBe('<b>one</b><i>two</i>');
	expect(
		await render('{["one", "two"].map(item => <Fragment><b>{item}</b><i>{item}</i></Fragment>)}'),
	).toBe('<b>one</b><i>one</i><b>two</b><i>two</i>');
	expect(
		await render('<Fragment><b>scoped</b></Fragment><style>b { color: red }</style>'),
	).not.toContain('Fragment');
});
it.each([
	'<Fragment class="wrapper"/>',
	'<Fragment {...{title: "wrapper"}}/>',
	'<Fragment set:html="raw"/>',
	'{true && <Fragment id="wrapper"/>}',
	'<Fragment slot="header"/>',
])('rejects invalid Fragment usage: %s', async (source) => {
	expect((await compile(source)).diagnostics.some((d) => d.severity === 'error')).toBe(true);
});

it('maps component prop diagnostics after boolean, spread, multiline and Unicode attributes', async () => {
	const source = `---
import Card from './Card.xph';
---
<Card active {...{label: 'é😀'}}
  count="wrong" />`;
	const result = await compile(source, {
		components: {
			Card: {
				id: 'Card',
				props: {
					kind: 'object',
					fields: {
						active: { type: { kind: 'boolean' }, optional: false },
						label: { type: { kind: 'string' }, optional: false },
						count: { type: { kind: 'number' }, optional: false },
					},
				},
			},
		},
	});
	const diagnostic = result.diagnostics.find(
		(d) => d.source === 'typescript' && d.message.includes('number'),
	);
	expect(diagnostic).toBeDefined();
	expect(source.slice(diagnostic!.start, diagnostic!.end)).toBe('count');
});

it('renders slots synchronously, escaping text and returning empty strings for missing slots', async () => {
	expect(await render('<div set:html={xph.slots.render("default")} />', {}, '<b>slot</b>')).toBe(
		'<div><b>slot</b></div>',
	);
	expect(await render('<p>{xph.slots.render("default")}</p>', {}, '<b>slot</b>')).toBe(
		'<p>&lt;b&gt;slot&lt;/b&gt;</p>',
	);
	expect(await render('<p>{xph.slots.render("missing", [1, "value"])}</p>')).toBe('<p></p>');
	expect(
		await render('<div set:html={xph.slots.render("default", [42])} />', {}, '<b>ordinary</b>'),
	).toBe('<div><b>ordinary</b></div>');
});

it('treats undefined slot argument arrays as omitted', async () => {
	expect(
		await render(
			'<div set:html={xph.slots.render("default", undefined)} />',
			{},
			'<b>ordinary</b>',
		),
	).toBe('<div><b>ordinary</b></div>');
});

it('passes slot arguments to callbacks, preserving parent and loop captures', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-slot-callbacks-'));
	try {
		await writeFile(
			join(root, 'List.xph'),
			`---
export interface Props { items: string[] }
---
<ul>{props.items.map((item, index) => <li set:html={xph.slots.render('default', [item, index])} />)}</ul><header set:html={xph.slots.render('header', ['heading'])} /><footer set:html={xph.slots.render('missing')} />`,
		);
		await writeFile(
			join(root, 'Page.xph'),
			`---
import List from './List.xph';
export interface Props { labels: string[]; prefix: string }
---
{props.labels.map(label => <List items={['<one>', 'two']}>
{(item: string, index: number) => <b>{props.prefix}{label}:{index}:{item}</b>}
<Fragment slot="header">{(title: string) => <i>{label}:{title}</i>}</Fragment>
</List>)}`,
		);
		const result = await build({ root, srcDir: '.' });
		expect(result.diagnostics).toEqual([]);
		const output = execFileSync(
			'php',
			[
				'-r',
				`require ${JSON.stringify(join(root, 'dist/xph.php'))}; echo \\Xph\\render('Page', ['labels'=>['A','B'], 'prefix'=>'+']);`,
			],
			{ encoding: 'utf8' },
		);
		expect(output).toBe(
			['A', 'B']
				.map(
					(label) =>
						`<ul><li><b>+${label}:0:&lt;one&gt;</b></li><li><b>+${label}:1:two</b></li></ul><header><i>${label}:heading</i></header><footer></footer>`,
				)
				.join(''),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('recursively renders xph.self in markup and expressions with checked props', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-self-'));
	try {
		await writeFile(
			join(root, 'Tree.xph'),
			`---
export interface Props { depth: number }
---
<p>{props.depth}</p>{props.depth > 1 ? <xph.self depth={props.depth - 1} /> : null}{props.depth === 1 && <xph.self depth={0} />}`,
		);
		await writeFile(
			join(root, 'Page.xph'),
			`---
import Tree from './Tree.xph';
---
<Tree depth={3} />`,
		);
		const result = await build({ root, srcDir: '.' });
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.Tree.dependencies).toEqual([]);
		expect(
			execFileSync(
				'php',
				[
					'-r',
					`require ${JSON.stringify(join(root, 'dist/xph.php'))}; echo \\Xph\\render('Page');`,
				],
				{ encoding: 'utf8' },
			),
		).toBe('<p>3</p><p>2</p><p>1</p><p>0</p>');
		const staticSelf = await compile(front('depth: number', '<xph.self {...props} />'), {
			scopeId: 'Tree',
		});
		expect(staticSelf.diagnostics).toEqual([]);
		expect(staticSelf.php).toContain("\\Xph\\render('Tree',");
		const invalid = await compile(front('depth: number', '<xph.self depth="wrong" />'));
		expect(invalid.diagnostics.some((d) => d.source === 'typescript')).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	'<p>{xph.slots.render()}</p>',
	'<p>{xph.slots.render(123)}</p>',
	'<p>{xph.slots.render("default", "wrong")}</p>',
	'{(value: string) => <b>{value}</b>}',
	`---\nimport Child from './Child.xph';\n---\n<Child>{value => <b>{value}</b>}</Child>`,
	`---\nimport Child from './Child.xph';\n---\n<Child>{(value: string) => { return <b>{value}</b>; }}</Child>`,
	`---\nimport Child from './Child.xph';\n---\n<Child>{(value: string) => <b>{value}</b>}other</Child>`,
])('rejects invalid xph slot syntax: %s', async (source) => {
	expect((await compile(source)).diagnostics.some((d) => d.severity === 'error')).toBe(true);
});

it.each([
	'<Child>{async (value: string) => <b>{value}</b>}</Child>',
	'<Child><Fragment><Fragment>{(value: string) => <b>{value}</b>}</Fragment></Fragment></Child>',
	'<Child><div>{(value: string) => <b>{value}</b>}</div></Child>',
	'<Child><Fragment><b slot="header">nested assignment</b></Fragment></Child>',
	'<Child>{(value: string) => <b>{value}</b>}{(value: string) => <i>{value}</i>}</Child>',
])('rejects unsupported slot callback placement or signatures: %s', async (template) => {
	const result = await compile("---\nimport Child from './Child.xph';\n---\n" + template);
	expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
});

it('forwards HTML compression to entry components and dependencies during builds', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-compress-'));
	try {
		await writeFile(join(root, 'Child.xph'), '<p>child\n  text</p>');
		await writeFile(
			join(root, 'Page.xph'),
			'---\nimport Child from "./Child.xph";\n---\n<div>page\n  text<Child> slot\n  text<p> paragraph\n  text</p><pre>  preserved\n  text</pre></Child></div>',
		);
		const result = await build({ root, srcDir: '.' });
		expect(result.diagnostics).toEqual([]);
		expect(result.components.get(join(root, 'Child.xph'))!.php).toContain('child text');
		const page = result.components.get(join(root, 'Page.xph'))!;
		expect(page.php).toContain('page text');
		const element = page.ir[0];
		expect(element.kind).toBe('element');
		if (element.kind === 'element') {
			const child = element.children[1];
			expect(child).toMatchObject({
				kind: 'element',
				children: [
					{ kind: 'text', value: ' slot text' },
					{ kind: 'element', name: 'p', children: [{ kind: 'text', value: ' paragraph text' }] },
					{
						kind: 'element',
						name: 'pre',
						children: [{ kind: 'text', value: '  preserved\n  text' }],
					},
				],
			});
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

describe('scopedStyleStrategy', () => {
	it.each(['attribute', 'class', 'where'] as const)(
		'scopes CSS and rendered HTML with %s',
		async (strategy) => {
			const source =
				'<div class="base" class:list={["listed"]}><p {...{class: "spread"}}>static</p>{true && <p class="jsx">jsx</p>}</div><style>div > p:hover::before { color: red } @keyframes spin { from { opacity: 0 } }</style>';
			const result = await compile(source, { scopedStyleStrategy: strategy });
			expect(result.diagnostics).toEqual([]);
			const css = result.assets[0].content;
			const marker = css.match(/(?:data-)?xph-[a-f0-9]+/)![0];
			const selector =
				strategy === 'attribute'
					? `[${marker}]`
					: strategy === 'class'
						? `.${marker}`
						: `:where(.${marker})`;
			expect(css).toContain(`div${selector}>p${selector}:hover:before`);
			expect(css).toContain('0%{opacity:0}');
			const html = await render(source, {}, '', undefined, undefined, strategy);
			if (strategy === 'attribute') {
				expect(html).toContain(`class="base listed" ${marker}=""`);
				expect(html.match(new RegExp(marker, 'g'))).toHaveLength(3);
			} else {
				expect(html).toBe(
					`<div class="base listed ${marker}"><p class="spread ${marker}">static</p><p class="jsx ${marker}">jsx</p></div>`,
				);
			}
		},
	);
	it('passes the configured strategy through builds', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-strategy-'));
		try {
			await writeFile(join(root, 'Page.xph'), '<p>hello</p><style>p { color: red }</style>');
			const result = await build({ root, srcDir: '.', scopedStyleStrategy: 'where' });
			expect(result.diagnostics).toEqual([]);
			expect(result.components.get(join(root, 'Page.xph'))!.assets[0].content).toContain(
				':where(.xph-',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('defaults to attribute scoping', async () => {
		const source = '<p>hello</p><style>p { color: red }</style>';
		expect(await compile(source)).toEqual(
			await compile(source, { scopedStyleStrategy: 'attribute' }),
		);
	});
});

it.each(['<script is:server>', '<script id="setup" is:server>', '<script\n is:server\n>'])(
	'extracts PHP implied by %s',
	(opening) => {
		const result = extractPHP(`${opening}return [];</script>`);
		expect(result.diagnostics).toEqual([]);
		expect(result.blocks.map((block) => block.code)).toEqual(['return [];']);
	},
);
it.each(['<script server lang="php">', '<script data-is:server>', '<script title=" is:server ">'])(
	'does not extract PHP without the is:server directive: %s',
	(opening) => {
		expect(extractPHP(`${opening}console.log(1);</script>`).blocks).toEqual([]);
	},
);

it('keeps imported types fresh between compilations sharing standard libraries', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-type-refresh-'));
	try {
		const types = join(directory, 'types.ts');
		const source = `---
import type { Model } from './types';
export interface Props { model: Model; }
---
<p>{props.model.title}</p>`;
		const options = { filename: join(directory, 'Page.xph') };
		await writeFile(types, 'export interface Model { title: string; }');
		const first = await compile(source, options);
		expect(first.diagnostics).toEqual([]);
		await writeFile(types, 'export interface Model { other: string; }');
		expect((await compile(source, options)).diagnostics.some((d) => d.severity === 'error')).toBe(
			true,
		);
		await writeFile(types, 'export interface Model { title: string; }');
		const restored = await compile(source, options);
		expect(restored.diagnostics).toEqual([]);
		expect(restored.php).toBe(first.php);
		await rm(types);
		expect((await compile(source, options)).diagnostics.some((d) => d.severity === 'error')).toBe(
			true,
		);
		await writeFile(types, 'export interface Model { title: string; }');
		expect((await compile(source, options)).diagnostics).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
