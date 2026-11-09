import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { build as themeBuild, createBuilder } from '../packages/xph-wordpress/src/build.js';
import wordpress from '../packages/xph-wordpress/src/vite.js';
import {
	build as viteBuild,
	createServer,
	resolveConfig,
} from '../packages/xph-wordpress/node_modules/vite/dist/node/index.js';
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
it('suppresses only its own timing warning and preserves the user warning handler', async () => {
	const messages: string[] = [];
	const config = await resolveConfig(
		{
			configFile: false,
			plugins: [wordpress({ outDir: 'theme' })],
			build: {
				rolldownOptions: {
					onwarn: (warning) => {
						messages.push(warning.message);
					},
				},
			},
		},
		'build',
	);
	const onwarn = config.build.rolldownOptions.onwarn!;
	const fallback = () => {
		throw new Error('User warning handler was bypassed');
	};
	onwarn(
		{
			code: 'PLUGIN_TIMINGS',
			message: 'Your build spent significant time in plugin `xph-wordpress`. See docs.',
		},
		fallback,
	);
	onwarn(
		{
			code: 'PLUGIN_TIMINGS',
			message: 'Your build spent significant time in plugin `another-plugin`. See docs.',
		},
		fallback,
	);
	onwarn({ code: 'OTHER_WARNING', message: 'Other warning from xph-wordpress' }, fallback);
	const timings =
		'JavaScript callbacks ran for 3.4s of this 3.4s build (100%).\nThe slowest callbacks:\n  - plugin xph-wordpress buildStart (100%, 3.4s, 1 call)\nSee https://rolldown.rs/reference/InputOptions.checks#bundlertimings for more details.';
	onwarn({ code: 'PLUGIN_TIMINGS', message: timings }, fallback);
	const mixed = timings + '\n  - plugin another-plugin transform (10%, 0.4s, 1 call)';
	onwarn({ code: 'PLUGIN_TIMINGS', message: mixed }, fallback);
	expect(messages).toEqual([
		'Your build spent significant time in plugin `another-plugin`. See docs.',
		'Other warning from xph-wordpress',
		mixed,
	]);
});

it('recompiles only the edited component and preserves unchanged output files', async () => {
	const f = await fixture();
	const rebuild = createBuilder({ root: f.root, outDir: 'theme' });
	const initial = await rebuild({ theme: true, dev: true });
	expect(errors(initial)).toEqual([]);
	expect(initial.compiled).toBeGreaterThan(1);
	const unchanged = join(f.out, 'components/components/Layout.php');
	const before = await stat(unchanged);
	await writeFile(join(f.root, 'src/theme/index.xph'), '<p>Fast update</p>');
	const updated = await rebuild({ theme: true, dev: true, sourceOnly: true });
	expect(errors(updated)).toEqual([]);
	expect(updated.compiled).toBe(1);
	expect((await stat(unchanged)).mtimeMs).toBe(before.mtimeMs);
	expect(await readFile(join(f.out, 'components/theme/index.php'), 'utf8')).toContain(
		'Fast update',
	);
	const clean = await themeBuild({ root: f.root, outDir: 'theme' }, { theme: true, dev: true });
	expect(updated.components).toEqual(clean.components);
});

it('can skip PHP validation in Vite development and production builds', async () => {
	const f = await fixture();
	const options = { outDir: 'theme', php: './missing-php', skipPhpCheck: true };
	const config = { root: f.root, configFile: false as const, logLevel: 'silent' as const };
	const server = await createServer({
		...config,
		plugins: [wordpress(options)],
		server: { middlewareMode: true },
	});
	await server.close();
	await viteBuild({ ...config, plugins: [wordpress(options)] });
	await expect(
		viteBuild({ ...config, plugins: [wordpress({ ...options, skipPhpCheck: false })] }),
	).rejects.toThrow('Cannot run php');
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
	const result = await themeBuild({ root: f.root, outDir: 'theme' }, { theme: true });
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
	const result = await themeBuild({ root: f.root, outDir: 'theme' }, { theme: true });
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
	const result = await themeBuild({ root: f.root, outDir: 'theme' }, { theme: true });
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
	await themeBuild(config, { theme: true, dev: true });
	const good = await readFile(join(f.out, 'index.php'), 'utf8');
	await writeFile(join(f.out, 'unrelated.txt'), 'keep');
	await writeFile(join(f.root, 'src/theme/index.php'), '<?php');
	expect(errors(await themeBuild(config, { theme: true }))[0].message).toContain('collision');
	expect(await readFile(join(f.out, 'index.php'), 'utf8')).toBe(good);
	await rm(join(f.root, 'src/theme/index.php'));
	await writeFile(
		join(f.root, 'src/theme/landing.xph'),
		`---\nexport const template = { name: 'Bad\\nHeader' };\n---\n<p />`,
	);
	expect(errors(await themeBuild(config, { theme: true }))[0].message).toContain('metadata');
	await rm(join(f.root, 'src/theme/landing.xph'));
	expect(errors(await themeBuild(config, { theme: true }))).toEqual([]);
	await expect(access(join(f.out, 'landing.php'))).rejects.toThrow();
	await expect(access(join(f.out, 'dev.json'))).rejects.toThrow();
	expect(await readFile(join(f.out, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('builds through Vite without HTML or development artifacts', async () => {
	const f = await fixture();
	await viteBuild({
		root: f.root,
		configFile: false,
		logLevel: 'silent',
		plugins: [wordpress({ outDir: 'theme' })],
	});
	expect(await readFile(join(f.out, 'index.php'), 'utf8')).not.toContain('@vite/client');
	await expect(access(join(f.out, 'dev.json'))).rejects.toThrow();
	expect(() => wordpress({} as never)).toThrow('outDir');
});
it('proxies HTML, POST, redirects, cookies and binary bodies while keeping Vite routes local', async () => {
	const f = await fixture();
	const upstream = httpServer((req, res) => {
		const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
		if (req.url === '/redirect') {
			res.writeHead(302, {
				Location: origin + '/destination',
				'Set-Cookie': 'test=yes; Domain=127.0.0.1; Path=/wordpress',
			});
			res.end();
		} else if (req.url === '/binary') {
			res.setHeader('Content-Type', 'image/png');
			res.end(Buffer.from([0, 255, 5]));
		} else if (req.method === 'POST') {
			let body = '';
			req.on('data', (data) => (body += data));
			req.on('end', () => {
				res.statusCode = 201;
				res.end(body + ':' + req.headers.cookie);
			});
		} else {
			const html = `<html><head></head><body><a href="${origin}/hello">Hello</a></body></html>`;
			res.writeHead(200, {
				'Content-Type': 'text/html',
				'Content-Length': Buffer.byteLength(html),
				ETag: 'old',
			});
			res.end(html);
		}
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
	const server = await createServer({
		root: f.root,
		configFile: false,
		logLevel: 'silent',
		plugins: [wordpress({ outDir: 'theme', devProxyTarget: target })],
		server: { port: 0, host: '127.0.0.1' },
	});
	try {
		await server.listen();
		const origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
		const response = await fetch(origin);
		const html = await response.text();
		expect(html).toContain('/@vite/client');
		expect(html).not.toContain(target);
		expect(response.headers.get('etag')).toBeNull();
		if (response.headers.has('content-length'))
			expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(html));
		const post = await fetch(origin + '/post', {
			method: 'POST',
			body: 'hello=body',
			headers: { Cookie: 'logged=in' },
		});
		expect(post.status).toBe(201);
		expect(await post.text()).toBe('hello=body:logged=in');
		const redirect = await fetch(origin + '/redirect', { redirect: 'manual' });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get('location')).toBe(origin + '/destination');
		expect(redirect.headers.get('set-cookie')).toBe('test=yes; Path=/');
		expect(Buffer.from(await (await fetch(origin + '/binary')).arrayBuffer())).toEqual(
			Buffer.from([0, 255, 5]),
		);
		expect(await (await fetch(origin + '/@vite/client')).text()).toContain('WebSocket');
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		const offline = await fetch(origin + '/offline');
		expect(offline.status).toBe(502);
		expect(await offline.text()).toContain('WordPress is unavailable');
	} finally {
		await server.close();
		upstream.close();
	}
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
		expect(errors(await themeBuild({ root: f.root, outDir: 'theme' }, { theme: true }))).toEqual(
			[],
		);
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
	expect(
		errors(await themeBuild({ root: a.root, outDir: 'theme' }, { theme: true }))[0].message,
	).toContain('functions.xph');
});

it('serializes development rebuilds, preserves last good files and reloads after recovery', async () => {
	const f = await fixture();
	const server = await createServer({
		root: f.root,
		configFile: false,
		logLevel: 'silent',
		plugins: [wordpress({ outDir: 'theme' })],
		server: { middlewareMode: true },
	});
	const messages: any[] = [];
	const send = server.ws.send.bind(server.ws);
	server.ws.send = ((...args: any[]) => {
		messages.push(args[0]);
	}) as typeof send;
	async function until(test: () => Promise<boolean>) {
		for (let i = 0; i < 100; i++) {
			if (await test()) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error('Rebuild timed out');
	}
	try {
		const good = await readFile(join(f.out, 'index.php'), 'utf8');
		await writeFile(join(f.root, 'src/theme/index.xph'), '---\nconst invalid = ;\n---\n<p />');
		server.watcher.emit('all', 'change', join(f.root, 'src/theme/index.xph'));
		await until(async () => messages.some((message) => message.type === 'error'));
		expect(await readFile(join(f.out, 'index.php'), 'utf8')).toBe(good);
		expect(messages.some((message) => message.type === 'full-reload')).toBe(false);
		await writeFile(join(f.root, 'src/theme/index.xph'), '<p>Recovered</p>');
		await writeFile(join(f.root, 'src/theme/new.php'), '<?php echo "Added";');
		server.watcher.emit('all', 'change', join(f.root, 'src/theme/index.xph'));
		await until(async () => messages.some((message) => message.type === 'full-reload'));
		expect(await readFile(join(f.out, 'new.php'), 'utf8')).toContain('Added');
		expect(JSON.parse(await readFile(join(f.out, 'dev.json'), 'utf8')).errors).toEqual([]);
		messages.length = 0;
		await rm(join(f.root, 'src/theme/new.php'));
		server.watcher.emit('all', 'unlink', join(f.root, 'src/theme/new.php'));
		await until(async () => messages.some((message) => message.type === 'full-reload'));
		await expect(access(join(f.out, 'new.php'))).rejects.toThrow();
	} finally {
		await server.close();
	}
});

it('waits for the theme render before completing Vite hot updates', async () => {
	const f = await fixture();
	const plugin = wordpress({ outDir: 'theme' });
	const server = await createServer({
		root: f.root,
		configFile: false,
		logLevel: 'silent',
		plugins: [plugin],
		server: { middlewareMode: true },
	});
	try {
		const source = join(f.root, 'src/theme/index.xph');
		await writeFile(source, '<p>Render completed</p>');
		const hook = plugin.hotUpdate;
		if (typeof hook !== 'function') throw new Error('Missing hot update hook');
		server.watcher.emit('all', 'change', source);
		const update = Reflect.apply(hook, {}, [{ file: source }]);
		expect(await readFile(join(f.out, 'components/theme/index.php'), 'utf8')).not.toContain(
			'Render completed',
		);
		await expect(update).resolves.toEqual([]);
		expect(await readFile(join(f.out, 'components/theme/index.php'), 'utf8')).toContain(
			'Render completed',
		);
	} finally {
		await server.close();
	}
});

it('allows PHP-only themes and rejects reserved outputs and header-breaking metadata', async () => {
	const f = await fixture();
	await rm(join(f.root, 'src'), { recursive: true });
	await mkdir(join(f.root, 'src/theme'), { recursive: true });
	await writeFile(join(f.root, 'src/theme/index.php'), '<?php echo "PHP only";');
	const config = { root: f.root, outDir: 'theme' };
	expect(errors(await themeBuild(config, { theme: true }))).toEqual([]);
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
			errors(await themeBuild(config, { theme: true })).some((d) =>
				d.message.includes('Invalid template metadata'),
			),
		).toBe(true);
	}
	await rm(join(f.root, 'src/theme/custom.xph'));
	await writeFile(join(f.root, 'src/theme/functions.php'), '<?php');
	expect(
		errors(await themeBuild(config, { theme: true })).some((d) => d.message.includes('collision')),
	).toBe(true);
});
