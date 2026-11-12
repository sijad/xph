import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build as themeBuild, createBuilder } from '../packages/xph-wordpress/src/build.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'xph-theme-'));
	roots.push(root);
	await mkdir(join(root, 'src/theme/includes'), { recursive: true });
	await mkdir(join(root, 'src/components'));
	await writeFile(
		join(root, 'src/components/Layout.xph'),
		'<html><head></head><body><slot /></body></html><style>body { color: red; }</style><script>console.log("theme");</script>',
	);
	await writeFile(
		join(root, 'src/theme/index.xph'),
		`---\nimport Layout from '../components/Layout.xph';\n---\n<Layout><h1>Hello theme</h1></Layout>`,
	);
	await writeFile(
		join(root, 'src/theme/landing.xph'),
		`---\nexport const template = { name: 'Landing Page', postTypes: ['page', 'post'] };\n---\n<p>Landing</p>`,
	);
	await writeFile(
		join(root, 'src/theme/functions.xph'),
		`<script is:server>require_once dirname(__DIR__, 2) . '/includes/helpers.php'; add_action('after_setup_theme', 'my_theme_setup'); $GLOBALS['boots'] = ($GLOBALS['boots'] ?? 0) + 1; return [];</script><p>Discard me</p>`,
	);
	await writeFile(
		join(root, 'src/theme/includes/helpers.php'),
		'<?php function my_theme_setup() { $GLOBALS["setup"] = true; }',
	);
	await writeFile(join(root, 'src/theme/single.php'), '<?php echo "Native PHP";');
	await writeFile(join(root, 'src/theme/style.css'), '/* Theme Name: XPH test */');
	await writeFile(join(root, 'src/theme/image.png'), Buffer.from([0, 255, 3, 128]));
	return { root, out: join(root, 'theme') };
}
const errors = (result: Awaited<ReturnType<typeof themeBuild>>) =>
	result.diagnostics.filter((d) => d.severity === 'error');
const acfModule = JSON.stringify(
	fileURLToPath(new URL('../packages/xph-wordpress/src/acf.ts', import.meta.url)),
);
const fields = `import { createAcfGroup } from ${acfModule};
export const home = createAcfGroup({ key: 'home', title: 'Home', location: [[{ param: 'page_type', operator: '==', value: 'front_page' }]], fields: [] });`;

it('registers src/acf.ts before native theme initialization, once', async () => {
	const f = await fixture();
	await rm(join(f.root, 'src/theme/functions.xph'));
	await writeFile(
		join(f.root, 'src/theme/functions.php'),
		`<?php $GLOBALS['theme_ready'] = $GLOBALS['acf_ready'];`,
	);
	await writeFile(join(f.root, 'src/acf.ts'), fields);
	const config = { root: f.root, outDir: 'theme' };
	expect(errors(await themeBuild(config))).toEqual([]);
	const { stdout } = await exec('php', [
		'-r',
		`function add_action(...$args) {} function get_theme_file_uri($path) { return $path; }
function acf_add_local_field_group($group) { $GLOBALS['acf_ready'] = ($GLOBALS['acf_ready'] ?? 0) + 1; }
require $argv[1] . '/functions.php'; require $argv[1] . '/functions.php'; echo json_encode([$GLOBALS['acf_ready'], $GLOBALS['theme_ready']]);`,
		f.out,
	]);
	expect(JSON.parse(stdout)).toEqual([1, 1]);
	await rm(join(f.root, 'src/acf.ts'));
	expect(errors(await themeBuild(config))).toEqual([]);
	await expect(access(join(f.out, 'acf.generated.php'))).rejects.toThrow();
	expect(await readFile(join(f.out, 'register.php'), 'utf8')).not.toContain('acf.generated.php');
});

it('rejects theme files that collide with the ACF registration', async () => {
	const f = await fixture();
	await writeFile(join(f.root, 'src/acf.ts'), fields);
	await writeFile(join(f.root, 'src/theme/acf.generated.php'), '<?php');
	expect(errors(await themeBuild({ root: f.root, outDir: 'theme' }))[0].message).toContain(
		'collision',
	);
});

it('recompiles only the edited component and preserves unchanged output files', async () => {
	const f = await fixture();
	const rebuild = createBuilder({ root: f.root, outDir: 'theme' });
	const initial = await rebuild({ dev: true });
	expect(errors(initial)).toEqual([]);
	expect(initial.compiled).toBeGreaterThan(1);
	const unchanged = join(f.out, 'components/components/Layout.php');
	const before = await stat(unchanged);
	await writeFile(join(f.root, 'src/theme/index.xph'), '<p>Fast update</p>');
	const updated = await rebuild({ dev: true, sourceOnly: true });
	expect(errors(updated)).toEqual([]);
	expect(updated.compiled).toBe(1);
	expect((await stat(unchanged)).mtimeMs).toBe(before.mtimeMs);
	expect(await readFile(join(f.out, 'components/theme/index.php'), 'utf8')).toContain(
		'Fast update',
	);
	const clean = await themeBuild({ root: f.root, outDir: 'theme' }, { dev: true });
	expect(updated.components).toEqual(clean.components);
});

it('can skip PHP validation', async () => {
	const f = await fixture();
	const config = { root: f.root, outDir: 'theme', php: './missing-php' };
	expect(errors(await themeBuild(config, { skipPhpCheck: true }))).toEqual([]);
	const result = await themeBuild(config).catch((e: Error) => e);
	expect(result instanceof Error ? result.message : JSON.stringify(errors(result))).toContain(
		'Cannot run php',
	);
});

it('accepts template names as strings with optional exports and validates their headers', async () => {
	const f = await fixture();
	const file = join(f.root, 'src/theme/landing.xph');
	const config = { root: f.root, outDir: 'theme' };
	for (const declaration of [
		`const template = 'My Template';`,
		`export const template = 'My Template';`,
		`const template = { name: 'My Template' };`,
	]) {
		await writeFile(file, `---\n${declaration}\n---\n<p>Landing</p>`);
		expect(errors(await themeBuild(config))).toEqual([]);
		const output = await readFile(join(f.out, 'landing.php'), 'utf8');
		expect(output).toContain('Template Name: My Template\nTemplate Post Type: page');
	}
	for (const name of ['', '  ', 'Bad\nHeader', 'Bad*/Header', 'Bad?>Header']) {
		await writeFile(file, `---\nconst template = ${JSON.stringify(name)};\n---\n<p />`);
		expect(
			errors(await themeBuild(config)).some((d) => d.message.includes('Invalid template metadata')),
		).toBe(true);
	}
	await writeFile(
		join(f.root, 'src/theme/functions.xph'),
		`---\nconst template = 'Invalid';\n---\n<script is:server>return [];</script>`,
	);
	expect(
		errors(await themeBuild(config)).some((d) =>
			d.message.includes('functions.xph cannot export template metadata'),
		),
	).toBe(true);
});

it('provides text encoding globals to bundled metadata dependencies', async () => {
	const f = await fixture();
	await writeFile(
		join(f.root, 'src/metadata.ts'),
		`export const name = new TextDecoder().decode(new TextEncoder().encode('Landing é'));`,
	);
	await writeFile(
		join(f.root, 'src/theme/landing.xph'),
		`---\nimport { name } from '../metadata';\nexport const template = { name };\n---\n<p>Landing</p>`,
	);
	const result = await themeBuild({ root: f.root, outDir: 'theme' });
	expect(errors(result)).toEqual([]);
	expect(await readFile(join(f.out, 'landing.php'), 'utf8')).toContain('Template Name: Landing é');
});

it('handles frontmatter CSS imports while evaluating WordPress metadata', async () => {
	const f = await fixture();
	await writeFile(
		join(f.root, 'src/components/global.css'),
		'@font-face { font-family: Omnes; src: url("./fonts/omnes-regular.woff2"); }',
	);
	await writeFile(
		join(f.root, 'src/components/Layout.xph'),
		`---\nimport './global.css';\n---\n<html><body><slot /></body></html>`,
	);
	await writeFile(
		join(f.root, 'src/theme/landing.xph'),
		`---\nimport '../components/global.css';\nexport const template = { name: 'Landing Page' };\n---\n<p>Landing</p>`,
	);
	const result = await themeBuild({ root: f.root, outDir: 'theme' });
	expect(errors(result)).toEqual([]);
	expect(await readFile(join(f.out, 'landing.php'), 'utf8')).toContain('Landing Page');
	expect(
		[...result.components.values()]
			.flatMap((component) => component.assets)
			.some((asset) => asset.content.includes('fonts/omnes-regular.woff2')),
	).toBe(true);
});

it('renders hierarchy and selectable templates, initializes once, copies binary/PHP and resolves dependency assets', async () => {
	const f = await fixture();
	const result = await themeBuild({ root: f.root, outDir: 'theme' });
	expect(errors(result)).toEqual([]);
	expect(await readFile(join(f.out, 'image.png'))).toEqual(Buffer.from([0, 255, 3, 128]));
	expect(await readFile(join(f.out, 'landing.php'), 'utf8')).toContain(
		'Template Post Type: page, post',
	);
	const { stdout } = await exec('php', [
		'-r',
		`
$hooks = [];
function add_action($name, $callback) { $GLOBALS['hooks'][$name][] = $callback; }
function get_theme_file_uri($path) { return '/wp-content/themes/test' . $path; }
require $argv[1] . '/functions.php'; require $argv[1] . '/functions.php';
if ($GLOBALS['boots'] !== 1 || isset($GLOBALS['setup'])) throw new Exception('bootstrap ordering');
foreach ($hooks['after_setup_theme'] as $callback) $callback();
if (!$GLOBALS['setup']) throw new Exception('setup missing');
require $argv[1] . '/index.php'; require $argv[1] . '/single.php';`,
		f.out,
	]);
	expect(stdout).toContain('Hello theme');
	expect(stdout).toContain('Native PHP');
	expect(stdout).not.toContain('Discard me');
	expect(stdout).toMatch(/<link[^>]+wp-content\/themes\/test\/assets\/[^>]+><\/head>/);
	expect(stdout).toMatch(/<script type="module"[^>]+><\/script><\/body>/);
});
it('keeps successful output on collisions and metadata failures; cleans only owned files', async () => {
	const f = await fixture();
	const config = { root: f.root, outDir: 'theme' };
	await themeBuild(config, { dev: true });
	const good = await readFile(join(f.out, 'index.php'), 'utf8');
	await writeFile(join(f.out, 'unrelated.txt'), 'keep');
	await writeFile(join(f.root, 'src/theme/index.php'), '<?php');
	expect(errors(await themeBuild(config))[0].message).toContain('collision');
	expect(await readFile(join(f.out, 'index.php'), 'utf8')).toBe(good);
	await rm(join(f.root, 'src/theme/index.php'));
	await writeFile(
		join(f.root, 'src/theme/landing.xph'),
		`---\nexport const template = { name: 'Bad\\nHeader' };\n---\n<p />`,
	);
	expect(errors(await themeBuild(config))[0].message).toContain('metadata');
	await rm(join(f.root, 'src/theme/landing.xph'));
	expect(errors(await themeBuild(config))).toEqual([]);
	await expect(access(join(f.out, 'landing.php'))).rejects.toThrow();
	await expect(access(join(f.out, 'dev.json'))).rejects.toThrow();
	expect(await readFile(join(f.out, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('loads the live reload client on every page only in development', async () => {
	const f = await fixture();
	const config = { root: f.root, outDir: 'theme' };
	const client = 'http://127.0.0.1:1234/client.js';
	expect(errors(await themeBuild(config, { dev: true, client }))).toEqual([]);
	const page = async () =>
		(
			await exec('php', [
				'-r',
				`function add_action($name, $callback) {}
function get_theme_file_uri($path) { return $path; }
require $argv[1] . '/index.php';`,
				f.out,
			])
		).stdout;
	// Templates load it with their components' scripts.
	expect(await page()).toContain(`<script type="module" src="${client}"></script>`);
	expect(await readFile(join(f.out, 'register.php'), 'utf8')).not.toContain(client);
	expect(errors(await themeBuild(config, { client }))).toEqual([]);
	expect(await page()).not.toContain(client);
	await expect(access(join(f.out, 'dev.json'))).rejects.toThrow();
});

it('supports nested templates, mixed blocks, defaults and independent theme runtimes', async () => {
	const a = await fixture();
	const b = await fixture();
	await rm(join(b.root, 'src/theme/functions.xph'));
	await rm(join(b.root, 'src/theme/includes/helpers.php'));
	await mkdir(join(a.root, 'src/theme/pages'));
	await writeFile(
		join(a.root, 'src/theme/pages/special.xph'),
		`---\nexport const template = { name: 'Special' };\n---\n<p>Nested</p>`,
	);
	const helper = JSON.stringify(join(process.cwd(), 'packages/xph-wordpress/src/index.ts'));
	await writeFile(
		join(a.root, 'src/Block.xph'),
		`---\nimport { defineBlock } from ${helper};\nexport const block = defineBlock({ name: 'theme/notice', title: 'Notice' });\n---\n<p>Notice</p>`,
	);
	for (const f of [a, b])
		expect(errors(await themeBuild({ root: f.root, outDir: 'theme' }))).toEqual([]);
	expect(await readFile(join(a.out, 'pages/special.php'), 'utf8')).toContain(
		'Template Post Type: page',
	);
	const { stdout } = await exec('php', [
		'-r',
		`
function add_action($name, $callback) {}
function get_theme_file_uri($path) { return '/theme' . $path; }
require $argv[1] . '/register.php'; require $argv[2] . '/register.php';
require $argv[1] . '/pages/special.php'; require $argv[2] . '/index.php';`,
		a.out,
		b.out,
	]);
	expect(stdout).toContain('Nested');
	expect(stdout).toContain('Hello theme');
	expect(await readFile(join(a.out, 'blocks/theme/notice/block.json'), 'utf8')).toContain(
		'theme/notice',
	);
	await writeFile(
		join(a.root, 'src/theme/functions.xph'),
		`---\nexport const template = { name: 'Invalid' };\n---\n<p />`,
	);
	expect(errors(await themeBuild({ root: a.root, outDir: 'theme' }))[0].message).toContain(
		'functions.xph',
	);
});

it('allows PHP-only themes and rejects reserved outputs and header-breaking metadata', async () => {
	const f = await fixture();
	await rm(join(f.root, 'src'), { recursive: true });
	await mkdir(join(f.root, 'src/theme'), { recursive: true });
	await writeFile(join(f.root, 'src/theme/index.php'), '<?php echo "PHP only";');
	const config = { root: f.root, outDir: 'theme' };
	expect(errors(await themeBuild(config))).toEqual([]);
	expect(await readFile(join(f.out, 'index.php'), 'utf8')).toContain('PHP only');
	for (const template of [
		{ name: '' },
		{ name: 'bad*/header' },
		{ name: 'bad?>header' },
		{ name: 'Valid', postTypes: ['bad,type'] },
		{ name: 'Valid', postTypes: [] },
		{ name: 'Valid', postTypes: null },
	]) {
		await writeFile(
			join(f.root, 'src/theme/custom.xph'),
			`---\nexport const template = ${JSON.stringify(template)};\n---\n<p />`,
		);
		expect(
			errors(await themeBuild(config)).some((d) => d.message.includes('Invalid template metadata')),
		).toBe(true);
	}
	await rm(join(f.root, 'src/theme/custom.xph'));
	await writeFile(join(f.root, 'src/theme/functions.php'), '<?php');
	expect(errors(await themeBuild(config))).toEqual([]);
	await writeFile(join(f.root, 'src/theme/functions.xph'), '<script is:server>return [];</script>');
	expect(errors(await themeBuild(config)).some((d) => d.message.includes('collision'))).toBe(true);
});

it('swaps styles for <style> edits, reloads for markup, and ignores the WordPress install', async () => {
	const f = await fixture();
	const theme = 'wp/wp-content/themes/test';
	await mkdir(join(f.root, theme), { recursive: true });
	await writeFile(join(f.root, 'wp/wp-load.php'), '<?php');
	await writeFile(join(f.root, 'xph.config.ts'), `export default { outDir: '${theme}' };`);
	const child = spawn(
		process.execPath,
		[resolve('packages/xph-wordpress/dist/cli.js'), 'dev', join(f.root, 'xph.config.ts')],
		{ stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } },
	);
	const exited = new Promise((done) => child.once('exit', done));
	let log = '';
	child.stdout.on('data', (data) => (log += data));
	child.stderr.on('data', (data) => (log += data));
	const events: string[] = [];
	const controller = new AbortController();
	async function until(test: () => boolean) {
		for (let i = 0; i < 200; i++) {
			if (child.exitCode !== null) throw new Error(log);
			if (test()) return;
			await new Promise((done) => setTimeout(done, 50));
		}
		throw new Error('Timed out: ' + log);
	}
	try {
		await until(() => /live reload at (\S+)/.test(log));
		const client = log.match(/live reload at (\S+)/)![1];
		const response = await fetch(new URL('events', client), { signal: controller.signal });
		void (async () => {
			try {
				for await (const chunk of response.body!.pipeThrough(new TextDecoderStream()))
					for (const [, event] of chunk.matchAll(/^event: (.*)$/gm)) events.push(event);
			} catch {
				/* Aborted. */
			}
		})();
		expect(await readFile(join(f.root, theme, 'manifest.php'), 'utf8')).toContain(client);
		const layout = join(f.root, 'src/components/Layout.xph');
		const markup =
			'<html><head></head><body><slot /></body></html><script>console.log("theme");</script>';
		await writeFile(layout, markup + '<style>body { color: blue; }</style>');
		await until(() => events.length > 0);
		expect(events).toEqual(['styles']);
		await mkdir(join(f.root, 'wp/wp-content/uploads'), { recursive: true });
		await writeFile(join(f.root, 'wp/wp-content/uploads/image.txt'), 'upload');
		await writeFile(join(f.root, 'wp/debug.log'), 'log');
		await new Promise((done) => setTimeout(done, 500));
		expect(events).toEqual(['styles']);
		await writeFile(
			layout,
			markup.replace('<slot />', '<main><slot /></main>') + '<style>body { color: blue; }</style>',
		);
		await until(() => events.includes('reload'));
		expect(events).toEqual(['styles', 'ok', 'reload']);
	} finally {
		controller.abort();
		child.kill();
		await exited;
	}
});
