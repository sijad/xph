import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { build } from '../packages/xph-wordpress/src/build.js';
import { editor } from '../packages/xph-wordpress/src/editor.js';
import { defineBlock } from '../packages/xph-wordpress/src/index.js';

const exec = promisify(execFile);
const directories: string[] = [];
const helper = JSON.stringify(resolve('packages/xph-wordpress/src/index.js'));
const errors = (result: Awaited<ReturnType<typeof build>>) =>
	result.diagnostics.filter((d) => d.severity === 'error');
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

it('checks v3 metadata, Props defaults, controls, variations and supports at type level', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-wordpress-types-'));
	directories.push(root);
	await writeFile(
		join(root, 'tsconfig.json'),
		JSON.stringify({
			extends: resolve('tsconfig.json'),
			compilerOptions: { rootDir: resolve('.'), typeRoots: [resolve('node_modules/@types')] },
			include: [resolve('tests/fixtures/wordpress-block-types.ts')],
		}),
	);
	await exec(resolve('node_modules/.bin/tsc'), [
		'--noEmit',
		'--project',
		join(root, 'tsconfig.json'),
	]).catch((error) => {
		throw new Error(error.stdout);
	});
});

async function fixture(metadata = '') {
	const root = await mkdtemp(join(tmpdir(), 'xph-wordpress-'));
	directories.push(root);
	await mkdir(join(root, 'src'));
	await writeFile(join(root, 'labels.ts'), "export const title = 'Card';");
	await writeFile(join(root, 'src', 'Child.xph'), '<p>Child</p><style>p { color: blue; }</style>');
	const source = `---
import { defineBlock } from ${helper};
import { title } from '../labels.js';
import Child from './Child.xph';
interface Props { heading: string; count: number; mode: 'small' | 'large'; }
interface Server { upper: string; }
export const block = defineBlock<Props>({
  name: 'example/card', title: title.toUpperCase(),
  attributes: { heading: { default: 'Hello', control: 'Heading' }, count: { default: 2, control: false }, mode: { default: 'small' } },
  supports: { html: false }, ${metadata}
});
---
<script is:server>return ['upper' => strtoupper($props['heading'])];</script>
<article><h2>{server.upper}</h2><span>{props.count}</span><Child /></article>
<style>article { border: 1px solid red; }</style>
<script>console.log('xph block');</script>`;
	await writeFile(join(root, 'src', 'Card.xph'), source);
	return { root, source, out: join(root, 'dist'), block: join(root, 'dist/blocks/example/card') };
}

it('builds v3 blocks from calculated metadata and renders PHP with imported components', async () => {
	const f = await fixture();
	await rename(join(f.root, 'src/Card.xph'), join(f.root, "src/Card's.xph"));
	const result = await build({ root: f.root });
	expect(errors(result)).toEqual([]);
	const metadata = JSON.parse(await readFile(join(f.block, 'block.json'), 'utf8'));
	expect(metadata).toMatchObject({
		apiVersion: 3,
		name: 'example/card',
		title: 'CARD',
		render: 'file:./render.php',
		viewScriptModule: 'file:./view.js',
		attributes: {
			heading: { type: 'string', default: 'Hello' },
			mode: { enum: ['small', 'large'] },
		},
	});
	const css = await readFile(join(f.block, 'style.css'), 'utf8');
	expect(metadata.attributes.heading).not.toHaveProperty('control');
	expect(metadata.attributes.count).not.toHaveProperty('control');
	expect(await readFile(join(f.block, 'editor.js'), 'utf8')).toContain(
		'"heading":"Heading","count":false',
	);
	expect(css).toContain('#00f');
	expect(css).toContain('red');
	expect(css).toContain('data-xph-');
	expect(await readFile(join(f.block, 'view.js'), 'utf8')).toContain('xph block');
	const { stdout } = await exec('php', [
		'-r',
		`
function add_action($action, $callback) { $callback(); }
function register_block_type($path) { if (!is_file($path . '/block.json')) throw new Exception('missing metadata'); }
function get_block_wrapper_attributes() { return 'class="wp-block-example-card"'; }
require $argv[1] . '/register.php';
$attributes = ['heading' => '<hello>', 'count' => 3, 'mode' => 'small'];
require $argv[1] . '/blocks/example/card/render.php';
`,
		f.out,
	]);
	expect(stdout).toContain('class="wp-block-example-card"');
	expect(stdout).toContain('&lt;HELLO&gt;');
	expect(stdout).toContain('Child</p>');
	for (const file of [
		'register.php',
		'runtime.php',
		'manifest.php',
		'blocks/example/card/render.php',
		'blocks/example/card/editor.asset.php',
	]) {
		const source = await readFile(join(f.out, file), 'utf8');
		expect(source).not.toContain('json_decode(');
		expect(source).not.toContain('base64_decode(');
		await exec('php', ['-l', join(f.out, file)]);
	}
	expect(await readFile(join(f.out, 'manifest.php'), 'utf8')).toContain("'components' => [");
});

it('validates without writing, and keeps last-good output on invalid v3 metadata', async () => {
	const f = await fixture();
	expect(errors(await build({ root: f.root }, { write: false }))).toEqual([]);
	await expect(access(f.out)).rejects.toThrow();
	await build({ root: f.root }, { dev: true });
	const previous = await readFile(join(f.out, 'register.php'), 'utf8');
	await writeFile(
		join(f.root, 'src/Card.xph'),
		f.source.replace('supports: { html: false }', "apiVersion: 2, supports: { html: 'invalid' }"),
	);
	const invalid = await build({ root: f.root });
	expect(errors(invalid).length).toBeGreaterThan(0);
	expect(await readFile(join(f.out, 'register.php'), 'utf8')).toBe(previous);
});

it('validates JavaScript defaults against nested Props and official support flags', async () => {
	const f = await fixture();
	// Import metadata from JavaScript to bypass the frontmatter TypeScript checker.
	await writeFile(
		join(f.root, 'bad.js'),
		`/** @type {any} */\nconst bad = { name: 'example/card', title: 'Bad', attributes: { heading: { default: 5 }, count: { default: 2 }, mode: { default: 'unknown' } }, supports: { html: 'invalid' } }; export default bad;`,
	);
	await writeFile(
		join(f.root, 'src/Card.xph'),
		f.source
			.replace(
				"import { title } from '../labels.js';",
				"import { title } from '../labels.js';\nimport bad from '../bad.js';",
			)
			.replace(
				/export const block = defineBlock<Props>\([\s\S]*?\n\}\);/,
				'export const block = defineBlock(bad);',
			),
	);
	const result = await build({ root: f.root });
	const messages = errors(result)
		.map((d) => d.message)
		.join('\n');
	expect(messages).toContain('Default for heading does not match Props');
	expect(messages).toContain('Default for mode does not match Props');
	expect(messages).toContain('/supports/html');
	await expect(access(f.out)).rejects.toThrow();
});

it('cleans removed blocks and development state while preserving developer-owned files', async () => {
	const f = await fixture();
	await build({ root: f.root }, { dev: true });
	await writeFile(join(f.out, 'plugin.php'), '<?php // developer owned');
	await writeFile(
		join(f.root, 'src/Card.xph'),
		f.source.replace('example/card', 'example/renamed'),
	);
	expect(errors(await build({ root: f.root }))).toEqual([]);
	await expect(access(join(f.block, 'block.json'))).rejects.toThrow();
	await expect(access(join(f.out, 'dev.json'))).rejects.toThrow();
	expect(await readFile(join(f.out, 'plugin.php'), 'utf8')).toContain('developer owned');
});

it('registers a PHP preview with typed enum controls and refreshes after development rebuilds', async () => {
	const block = defineBlock<{ mode: 'small' | 'large'; hidden?: string }>({
		name: 'example/card',
		title: 'Card',
		attributes: { mode: { default: 'small', control: 'Display mode' }, hidden: { control: false } },
	});
	let registered: any;
	let refresh: (() => Promise<void>) | undefined;
	let revision: unknown;
	let changed: unknown;
	let loads = 0;
	let state = {
		revision: 'new-build',
		signatures: { 'example/card': 'same' },
		errors: [] as string[],
	};
	const doc = { querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} } };
	const hooks = [undefined, undefined];
	let index = 0;
	const wp = {
		element: {
			Fragment: 'Fragment',
			createElement: (type: unknown, props: any, ...children: unknown[]) => ({
				type,
				props,
				children,
			}),
			useState(initial: unknown) {
				const slot = index++;
				return [
					hooks[slot] ?? initial,
					(value: never) => {
						hooks[slot] = value;
						if (slot === 0) revision = value;
					},
				];
			},
			useEffect(effect: () => unknown) {
				effect();
			},
			useRef: () => ({ current: { ownerDocument: doc } }),
		},
		blockEditor: { useBlockProps: () => ({}), InspectorControls: 'InspectorControls' },
		components: { PanelBody: 'PanelBody', SelectControl: 'SelectControl', Notice: 'Notice' },
		serverSideRender: { ServerSideRender: 'Preview' },
		blocks: {
			registerBlockType(_name: string, settings: unknown) {
				registered = settings;
			},
		},
	};
	vm.runInNewContext(
		editor(
			block,
			{
				mode: { type: 'string', default: 'small', enum: ['small', 'large'] },
				hidden: { type: 'string' },
			},
			true,
			'same',
		),
		{
			wp,
			URL,
			AbortController,
			console,
			document: {
				currentScript: { src: 'https://example.test/plugin/dist/blocks/example/card/editor.js' },
			},
			window: {
				location: {
					reload() {
						loads++;
					},
				},
			},
			fetch: async (url: URL) => {
				expect(url.href).toBe('https://example.test/plugin/dist/dev.json');
				return { ok: true, json: async () => state };
			},
			setInterval(callback: () => Promise<void>) {
				refresh = callback;
			},
			clearInterval() {},
		},
	);
	const rendered = registered.edit({
		attributes: { mode: 'small' },
		setAttributes: (value: unknown) => {
			changed = value;
		},
	});
	const control = rendered.children[0].children[0].children[0][0];
	expect(rendered.children[0].children[0].children[0]).toHaveLength(1);
	expect(control.props.label).toBe('Display mode');
	control.props.onChange('1');
	expect(changed).toEqual({ mode: 'large' });
	await refresh!();
	expect(revision).toBe('new-build');
	state = { ...state, signatures: { 'example/card': 'changed' } };
	await refresh!();
	expect(loads).toBe(1);
	index = 0;
});

it('watches imported metadata, reports errors, and recovers without losing the last build', async () => {
	const f = await fixture();
	await writeFile(join(f.root, 'xph.config.ts'), 'export default {};');
	const child = spawn(
		process.execPath,
		[resolve('packages/xph-wordpress/dist/cli.js'), 'dev', join(f.root, 'xph.config.ts')],
		{
			stdio: 'pipe',
			env: { ...process.env, CHOKIDAR_USEPOLLING: 'true', CHOKIDAR_INTERVAL: '50' },
		},
	);
	const exited = new Promise((resolve) => child.once('exit', resolve));
	let log = '';
	child.stdout.on('data', (data) => {
		log += data;
	});
	child.stderr.on('data', (data) => {
		log += data;
	});
	async function until(test: () => Promise<boolean>) {
		for (let attempt = 0; attempt < 120; attempt++) {
			if (child.exitCode !== null) throw new Error(log);
			try {
				if (await test()) return;
			} catch {
				/* Waiting for the first build. */
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error('Watcher timed out: ' + log);
	}
	const revision = async () => JSON.parse(await readFile(join(f.out, 'dev.json'), 'utf8'));
	try {
		await until(async () => !!(await revision()).revision);
		const first = (await revision()).revision;
		await writeFile(join(f.root, 'labels.ts'), "export const title = 'Updated';");
		await until(async () => (await revision()).revision !== first);
		expect(JSON.parse(await readFile(join(f.block, 'block.json'), 'utf8')).title).toBe('UPDATED');
		const good = await readFile(join(f.out, 'components/Card.php'), 'utf8');
		await writeFile(join(f.root, 'labels.ts'), 'export const title = ;');
		await until(async () => !!(await revision()).errors.length);
		expect(await readFile(join(f.out, 'components/Card.php'), 'utf8')).toBe(good);
		await writeFile(join(f.root, 'labels.ts'), "export const title = 'Recovered';");
		await until(async () => !(await revision()).errors.length);
		expect(JSON.parse(await readFile(join(f.block, 'block.json'), 'utf8')).title).toBe('RECOVERED');
	} finally {
		child.kill();
		await exited;
	}
});
