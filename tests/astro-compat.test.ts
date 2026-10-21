import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { build, compile } from '../packages/xph/src/index.js';

// Independently authored cases for the shared behavior covered by Astro's suites:
// https://github.com/withastro/compiler/tree/main/packages/compiler/test/basic
// https://github.com/withastro/astro/tree/main/packages/astro/test/units/render
// This tests xph's PHP output, not full Astro compatibility. Request-time JavaScript,
// hydration, routing, and intentional differences in security policy are excluded.
async function project(
	files: Record<string, string>,
	check: (root: string, result: Awaited<ReturnType<typeof build>>) => void | Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), 'xph-astro-compat-'));
	try {
		for (const [name, source] of Object.entries(files)) await writeFile(join(root, name), source);
		const result = await build({ root, entries: ['Page.xph'] });
		expect(result.diagnostics).toEqual([]);
		await check(root, result);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function php(root: string, code: string): string {
	return execFileSync(
		'php',
		[
			'-d',
			'display_errors=stderr',
			'-r',
			`require ${JSON.stringify(join(root, 'dist/xph.php'))}; ${code}`,
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	);
}

describe('Astro-style HTML rendering', () => {
	it.each([
		[
			'HTML comments and expression comments',
			'<p>before<!-- {notAnExpression} <b>literal</b> -->{/* hidden */}after</p>',
			'<p>before<!-- {notAnExpression} <b>literal</b> -->after</p>',
		],
		[
			'empty expressions and multiple expression comments',
			'<p>{}{ /* one */ /* two */ }before{ // line comment\n}after</p>',
			'<p>beforeafter</p>',
		],
		[
			'document declarations',
			'<!doctype html><html lang="en"><head><title>Title</title></head><body>Body</body></html>',
			'<!DOCTYPE html><html lang="en"><head><title>Title</title></head><body>Body</body></html>',
		],
		[
			'spaces around expressions and inline siblings',
			'<p>one {"two"} <b>three</b> four</p>\n<pre>  five\n\tsix  </pre>\n',
			'<p>one two <b>three</b> four</p> <pre>  five\n\tsix  </pre> ',
		],
		[
			'static entities and expression text',
			'<p>&amp; &lt; &#65; &#x1F600; {"&amp; <"}</p>',
			'<p>&amp; &lt; &#65; &#x1F600; &amp;amp; &lt;</p>',
		],
		[
			'void and self-closing nonvoid elements',
			'<div/><br/><hr/><input disabled/><img src="/icon.png" alt="icon"/>',
			'<div></div><br><hr><input disabled><img src="/icon.png" alt="icon">',
		],
		[
			'SVG element and attribute casing',
			'<svg viewBox="0 0 10 10"><linearGradient id="paint"><stop offset="0%" stop-color="red"/></linearGradient><path d="M0 0" fill="url(#paint)"/></svg>',
			'<svg viewBox="0 0 10 10"><linearGradient id="paint"><stop offset="0%" stop-color="red"></stop></linearGradient><path d="M0 0" fill="url(#paint)"></path></svg>',
		],
		[
			'custom elements with children and data attributes',
			'<my-panel data-state="ready"><span>child</span></my-panel>',
			'<my-panel data-state="ready"><span>child</span></my-panel>',
		],
		[
			'nested fragments and adjacent expressions',
			'<Fragment>{true ? <><b>{1}</b><i>{2}</i></> : null}{false}{null}{undefined}{0}{""}</Fragment>',
			'<b>1</b><i>2</i>0',
		],
	])('preserves %s', async (_name, source, expected) => {
		await project({ 'Page.xph': source }, (root) => {
			expect(php(root, "echo \\Xph\\render('Page');")).toBe(expected);
		});
	});

	it('renders different branches and empty lists across repeated requests', async () => {
		await project(
			{
				'Page.xph': `---
interface Props { show: boolean; items: string[] }
---
{props.show ? <ul>{props.items.map((item, index) => <li>{index}:{item}</li>)}</ul> : <p>hidden</p>}`,
			},
			(root) => {
				expect(
					php(
						root,
						`echo \\Xph\\render('Page', ['show'=>true, 'items'=>['<one>', 'two']]);
echo \\Xph\\render('Page', ['show'=>false, 'items'=>['unused']]);
echo \\Xph\\render('Page', ['show'=>true, 'items'=>[]]);`,
					),
				).toBe('<ul><li>0:&lt;one&gt;</li><li>1:two</li></ul><p>hidden</p><ul></ul>');
			},
		);
	});
});

describe('Astro-style component composition', () => {
	it('forwards named and default slots through an intermediate component', async () => {
		await project(
			{
				'Layout.xph':
					'<header><slot name="heading">heading fallback</slot></header><main><slot>body fallback</slot></main>',
				'Wrapper.xph': `---
import Layout from './Layout.xph';
---
<Layout><Fragment slot="heading"><slot name="heading">wrapper heading</slot></Fragment><slot> wrapper body </slot></Layout>`,
				'Page.xph': `---
import Wrapper from './Wrapper.xph';
---
<Wrapper><b slot="heading">Title</b><p>Body</p></Wrapper><Wrapper/>`,
			},
			(root) => {
				expect(php(root, "echo \\Xph\\render('Page');")).toBe(
					'<header><b>Title</b></header><main><p>Body</p></main><header>wrapper heading</header><main> wrapper body </main>',
				);
			},
		);
	});

	it('distinguishes a missing slot from an explicitly empty slot', async () => {
		await project(
			{
				'Child.xph':
					'<main><slot>fallback</slot></main><aside><slot name="aside">aside fallback</slot></aside>',
				'Page.xph': `---
import Child from './Child.xph';
---
<Child/><Child><Fragment/><Fragment slot="aside"/></Child><Child>{false && <b>hidden</b>}</Child>`,
			},
			(root) => {
				expect(php(root, "echo \\Xph\\render('Page');")).toBe(
					'<main>fallback</main><aside>aside fallback</aside><main></main><aside></aside><main></main><aside>aside fallback</aside>',
				);
			},
		);
	});

	it('keeps props, server values and slot captures local to each instance', async () => {
		await project(
			{
				'Child.xph': `---
interface Props { label: string; active?: boolean }
interface Server { label: string }
---
<script is:server>return ['label' => strtoupper($props['label'])];</script>
<section data-active={props.active}><h2>{server.label}</h2><slot/></section>`,
				'Page.xph': `---
import Child from './Child.xph';
interface Props { labels: string[] }
---
{props.labels.map(label => <Child {...{label: 'overridden', active: true}} label={label}><i>{label}</i></Child>)}<Child label="last"/>`,
			},
			(root) => {
				const expected =
					'<section data-active="true"><h2>ONE</h2><i>one</i></section><section data-active="true"><h2>TWO</h2><i>two</i></section><section><h2>LAST</h2></section>';
				expect(
					php(
						root,
						"echo \\Xph\\render('Page', ['labels'=>['one','two']]); echo \\Xph\\render('Page', ['labels'=>[]]);",
					),
				).toBe(expected + '<section><h2>LAST</h2></section>');
			},
		);
	});
});

describe('Astro-style styles and scripts', () => {
	it('keeps parent, child and slotted styles scoped to their owning component', async () => {
		await project(
			{
				'Child.xph': '<section><p>child</p><slot/></section><style>p { color: red }</style>',
				'Page.xph':
					"---\nimport Child from './Child.xph';\n---\n<div><p>parent</p><Child><p>slotted</p></Child></div><style>p { color: blue }</style>",
			},
			(root, result) => {
				const marker = (name: string) => {
					const component = result.components.get(join(root, name + '.xph'))!;
					return component.assets[0].content.match(/data-xph-[\w-]+/)![0];
				};
				const parent = marker('Page');
				const child = marker('Child');
				expect(parent).not.toBe(child);
				expect(php(root, "echo \\Xph\\render('Page');")).toBe(
					`<div ${parent}=""><p ${parent}="">parent</p><section ${child}=""><p ${child}="">child</p><p ${parent}="">slotted</p></section></div>`,
				);
			},
		);
	});

	it('bundles imported browser TypeScript into executable JavaScript', async () => {
		await project(
			{
				'helpers.ts': 'export function twice(value: number): number { return value * 2; }',
				'Page.xph': `<p>page</p><script>
import { twice } from './helpers';
const value: number = twice(3);
console.log('browser-result', value);
</script>`,
			},
			async (root, result) => {
				expect(php(root, "echo \\Xph\\render('Page');")).toBe('<p>page</p>');
				expect(result.manifest.Page.assets).toHaveLength(1);
				const asset = result.manifest.Page.assets[0];
				expect(asset.type).toBe('js');
				const messages: unknown[][] = [];
				const script = await readFile(join(root, 'dist', asset.url), 'utf8');
				runInNewContext(
					script,
					{ console: { log: (...args: unknown[]) => messages.push(args) } },
					{ timeout: 1000 },
				);
				expect(messages).toEqual([['browser-result', 6]]);
			},
		);
	});

	it('scopes each selector compound, including nested media rules, without scoping keyframe steps', async () => {
		const result = await compile(
			`<div><p>static</p>{true && <p>expression</p>}</div>
<style>div > p:hover::before { color: red } @media (min-width: 1px) { p { animation: spin 1s linear; animation-name: spin } } @keyframes spin { from { opacity: 0 } to { opacity: 1 } }</style>`,
			{ scopeId: 'Scope' },
		);
		expect(result.diagnostics).toEqual([]);
		const css = result.assets[0].content;
		const marker = css.match(/data-xph-[\w-]+/)![0];
		expect(css).toContain(`div[${marker}]>p[${marker}]:hover:before`);
		expect(css).toContain(`@media(min-width:1px){p[${marker}]`);
		const animation = css.match(/@keyframes (spin-[\w-]+)/)![1];
		expect(css).toContain(`animation:${animation} 1s linear`);
		expect(css).toContain(`animation-name:${animation}`);
		expect(css).toContain('0%{opacity:0}to{opacity:1}');
		expect(result.php.match(new RegExp(marker, 'g'))).toHaveLength(3);
	});

	it('preserves stylesheet order and deduplicates a shared dependency in a diamond graph', async () => {
		await project(
			{
				'Leaf.xph':
					'<b>leaf</b><style>b { margin-top: 1px }</style><script>console.log("leaf-script");</script>',
				'Left.xph':
					"---\nimport Leaf from './Leaf.xph';\n---\n<Leaf/><style is:global>body { margin-top: 2px }</style>",
				'Right.xph':
					"---\nimport Leaf from './Leaf.xph';\n---\n<Leaf/><style is:global>body { margin-top: 3px }</style>",
				'Page.xph':
					"---\nimport Left from './Left.xph';\nimport Right from './Right.xph';\n---\n<Left/><Right/><Left/><style is:global>body { margin-top: 4px }</style>",
			},
			async (root, result) => {
				const assets = JSON.parse(php(root, "echo json_encode(\\Xph\\assets('Page'));")) as {
					type: string;
					url: string;
				}[];
				expect(assets).toHaveLength(5);
				expect(new Set(assets.map((asset) => asset.url)).size).toBe(5);
				const css = await Promise.all(
					assets
						.filter((asset) => asset.type === 'css')
						.map((asset) => readFile(join(root, 'dist', asset.url), 'utf8')),
				);
				expect(css.map((content) => content.match(/margin-top:(\d+px)/)![1])).toEqual([
					'1px',
					'2px',
					'3px',
					'4px',
				]);
				expect(assets.filter((asset) => asset.type === 'js')).toEqual(
					result.manifest.Leaf.assets.filter((asset) => asset.type === 'js'),
				);
				expect(php(root, "echo \\Xph\\render('Page');").match(/>leaf<\/b>/g)).toHaveLength(3);
			},
		);
	});
});

describe('Astro-style syntax diagnostics', () => {
	it.each(['---\nconst value = ;\n---\n<p/>', '<p>{value + }</p>', '<p title={value + }>text</p>'])(
		'rejects malformed syntax without emitting PHP: %s',
		async (source) => {
			const result = await compile(source);
			const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
			expect(errors.length).toBeGreaterThan(0);
			for (const diagnostic of errors) {
				expect(diagnostic.start).toBeGreaterThanOrEqual(0);
				expect(diagnostic.end).toBeGreaterThanOrEqual(diagnostic.start);
				expect(diagnostic.end).toBeLessThanOrEqual(source.length);
			}
			expect(result.php).toBe('');
		},
	);
});
