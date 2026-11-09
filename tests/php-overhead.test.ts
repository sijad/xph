import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { phpLiteral } from '../packages/xph/src/contracts.js';
import { compile } from '../packages/xph/src/compiler.js';
import { build as wordpressBuild } from '../packages/xph-wordpress/src/build.js';
import { createBuilder } from '../packages/xph/src/build.js';

it('omits generated annotations while retaining user comments and accurate mappings', async () => {
	const source =
		'---\ninterface Server { title: string }\n---\n<script is:server>\n/** user comment */\nreturn ["title" => "Hello"];\n</script><p>{server.title}</p>';
	const normal = await compile(source);
	const compact = await compile(source, { compactPHP: true });
	expect(normal.diagnostics).toEqual([]);
	expect(compact.diagnostics).toEqual([]);
	expect(compact.php).toContain('/** user comment */');
	expect(compact.php).not.toContain('/** @param');
	expect(compact.php.length).toBeLessThan(normal.php.length);
	for (const mapping of compact.mappings) {
		expect(compact.php.slice(mapping.generatedStart, mapping.generatedEnd).length).toBeGreaterThan(
			0,
		);
		expect(mapping.generatedEnd).toBeLessThanOrEqual(compact.php.length);
	}
});

it('invalidates cached PHP for explicit compact overrides', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-compact-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/Page.xph'), '<p>Hello</p>');
		const rebuild = createBuilder({ root, compactPHP: true });
		const compact = await rebuild({ write: false });
		expect([...compact.components.values()][0].php).not.toContain('/** @param');
		expect((await rebuild({ write: false })).compiled).toBe(0);
		const wp = await wordpressBuild({ root }, { write: false });
		expect([...wp.components.values()][0].php).not.toContain('/** @param');
		const wpAnnotated = await wordpressBuild({ root, compactPHP: false }, { write: false });
		expect([...wpAnnotated.components.values()][0].php).toContain('/** @param');
		const annotated = await rebuild({ write: false, compactPHP: false });
		expect(annotated.compiled).toBe(1);
		expect([...annotated.components.values()][0].php).toContain('/** @param');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('marks only inert output as renderless', async () => {
	expect((await compile('')).renderless).toBe(true);
	expect((await compile('<script is:server>return [];</script>')).renderless).toBe(false);
	expect((await compile('<slot />')).renderless).toBe(false);
});

it('groups named props and retains spread boundaries', async () => {
	const result = await compile(
		'---\nexport interface Props { attrs: { title: string } }\n---\n<div id="a" title="b" {...props.attrs} aria-label="c" />',
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain("['id' => 'a', 'title' => 'b']");
	expect(result.php).toContain('\\Xph\\mergeProps(');
});

it('specializes literal required keys while keeping external and optional reads guarded', async () => {
	const result = await compile(`---
export interface Props { value: { title: string }; maybe?: { title: string } }
---
{({ title: props.value.title }).title}{props.maybe?.title}`);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain(")['title']");
	expect(result.php).toContain("\\Xph\\get($props, 'value', false)");
	expect(result.php).toContain("'title', true)");
});

it('retains script assets and dependencies when a renderless child call disappears', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-renderless-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/Script.xph'), '<script>console.log("loaded");</script>');
		await writeFile(
			join(root, 'src/Page.xph'),
			'---\nimport Script from "./Script.xph";\n---\n<Script />',
		);
		const result = await createBuilder({ root })();
		expect(result.diagnostics).toEqual([]);
		expect(result.components.get(join(root, 'src/Page.xph'))?.renderless).toBe(true);
		expect(result.manifest.Page.dependencies).toEqual(['Script']);
		expect(result.manifest.Script.assets[0].type).toBe('js');
		expect(result.components.get(join(root, 'src/Page.xph'))?.php).not.toContain('\\Xph\\render(');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function renderGenerated(
	source: string,
	props: Record<string, unknown> = {},
	options: Parameters<typeof compile>[1] = {},
) {
	const compiled = await compile(source, options);
	expect(compiled.diagnostics).toEqual([]);
	const root = await mkdtemp(join(tmpdir(), 'xph-overhead-render-'));
	try {
		const file = join(root, 'component.php');
		await writeFile(file, compiled.php);
		const output = execFileSync(
			'php',
			[
				'-r',
				`
set_error_handler(static function ($severity, $message) { throw new ErrorException($message, 0, $severity); });
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
$render = require ${JSON.stringify(file)};
echo $render(${phpLiteral(props)});
`,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
		return { compiled, output };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

it('flattens scoped class directives and evaluates attributes once in source order', async () => {
	const { compiled, output } = await renderGenerated(
		`---
interface Server { next(value: string): string; events(): string }
---
<script is:server>
$events = [];
return [
  'next' => static function ($value) use (&$events) { $events[] = $value; return $value; },
  'events' => static function () use (&$events) { return implode(',', $events); },
];
</script><button data-start={server.next('start')} class="base" class:list={['literal', '0', server.next('middle'), {'0': true}]} data-end={server.next('end')}>Button</button>{server.events()}<style>button { color: red }</style>`,
		{},
		{ scopedStyleStrategy: 'class', scopeId: 'Button' },
	);
	const scope = compiled.php.match(/xph-[a-f0-9]{12}/)![0];
	expect(output).toBe(
		`<button data-start="start" class="base literal 0 middle 0 ${scope}" data-end="end">Button</button>start,middle,end`,
	);
	expect(compiled.php.match(/\\Xph\\scopedClassProps\(/g)).toHaveLength(1);
	expect(compiled.php).not.toContain('\\Xph\\classProps(');
	expect(compiled.php).not.toMatch(/\\Xph\\classList\('(literal|0)'/);
});

it('keeps spread precedence when flattening scoped class lists', async () => {
	const { compiled, output } = await renderGenerated(
		`---
interface Props { attrs: { class: string }; active: boolean }
---
<div class="early" class:list={['literal', props.active ? 'active' : 'inactive']} {...props.attrs} /><style>div { color: red }</style>`,
		{ attrs: { class: 'late' }, active: true },
		{ scopedStyleStrategy: 'class' },
	);
	const scope = compiled.php.match(/xph-[a-f0-9]{12}/)![0];
	expect(output).toBe(`<div class="late literal active ${scope}"></div>`);
	expect(compiled.php).not.toContain('\\Xph\\mergeProps(');
});

it('specializes known map item fields, including null values, while guarding absent fields', async () => {
	const { compiled, output } = await renderGenerated(`---
const items: { title: string | null; optional?: string }[] = [{title: 'one', optional: 'extra'}, {title: null}];
---
{items.map(item => <p>{item.title}|{item.optional}</p>)}`);
	expect(output).toBe('<p>one|extra</p><p>|</p>');
	expect(compiled.php).toMatch(/\(\$\w+\)\['title'\]/);
	expect(compiled.php).not.toMatch(/\\Xph\\get\([^\n]+, 'title', false\)/);
	expect(compiled.php).toMatch(/\\Xph\\get\(\$\w+, 'optional', false\)/);
});

it('guards known item shapes when callbacks could mutate an item by reference', async () => {
	const { compiled, output } = await renderGenerated(`---
interface Server { mutate(item: { title: string }): string }
const items = [{title: 'one'}];
---
<script is:server>return ['mutate' => static function (&$item) { unset($item['title']); return 'changed'; }];</script>{items.map(item => <p>{server.mutate(item)}|{item.title}</p>)}`);
	expect(output).toBe('<p>changed|</p>');
	expect(compiled.php).toMatch(/\\Xph\\get\(\$\w+, 'title', false\)/);
});

it('retains undefined, null, optional and dynamic semantics for external props', async () => {
	const source = `---
interface Props { title: string; value: string | null; nested?: { title: string }; values: { [key: string]: string }; key: string }
---
{props.title === undefined ? 'missing' : 'present'}|{props.value === null ? 'null' : 'other'}|{props.nested?.title ?? 'fallback'}|{props.values[props.key] ?? 'dynamic'}`;
	const { compiled, output } = await renderGenerated(source, {
		value: null,
		values: {},
		key: 'absent',
	});
	expect(output).toBe('missing|null|fallback|dynamic');
	expect(compiled.php).toContain("\\Xph\\get($props, 'title', false)");
	expect(compiled.php).toContain("'title', true)");
});

it('omits empty else branches and default slot argument arrays', async () => {
	const compiled = await compile(
		`---
import Child from './Child.xph';
interface Props { visible: boolean }
---
<Child />{props.visible ? <i>shown</i> : null}{props.visible ? <b>shown</b> : ''}<slot />{xph.slots.render('named')}{xph.slots.render('named', [])}`,
		{
			components: { Child: { id: 'Child', props: { kind: 'object', fields: {} } } },
		},
	);
	expect(compiled.diagnostics).toEqual([]);
	expect(compiled.php).toContain("\\Xph\\render('Child', []);");
	expect(compiled.php).not.toContain('else {');
	expect(compiled.php.match(/\\Xph\\renderSlot\(\$slot, 'named'\)/g)).toHaveLength(2);
	const fallback = await renderGenerated('<slot>fallback</slot>');
	expect(fallback.output).toBe('fallback');
});

it('keeps array length handling when specializing serialized map items', async () => {
	const { compiled, output } = await renderGenerated(`---
const rows = [['one'], ['two', 'three']];
---
{rows.map(row => <p>{row.length}|{row[0]}</p>)}`);
	expect(output).toBe('<p>1|one</p><p>2|two</p>');
	expect(compiled.php).toContain('\\Xph\\length(');
	expect(compiled.php).not.toContain('\\Xph\\get(');
});

it('preserves errors for non-optional access on nullish external values', async () => {
	await expect(
		renderGenerated(
			`---
interface Props { value: { title: string } }
---
{props.value.title}`,
			{ value: null },
		),
	).rejects.toThrow('Property access on a nullish value');
});
