import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import renderer from '../packages/xph/src/astro-renderer.js';
import xph from '../packages/xph/src/astro-integration.js';

it('emits inline PHP that renders inside an evaluated HTML page in development', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-preview-'));
	try {
		const file = join(root, 'Card.xph');
		await writeFile(
			file,
			'---\ninterface Props { title: string }\n---\n<h1>{props.title}</h1><slot />',
		);
		const integration = xph();
		let plugin: any;
		integration.hooks['astro:config:setup']({
			command: 'dev',
			addRenderer: () => {},
			updateConfig: (config) => {
				plugin = config.vite.plugins[0];
			},
		});
		const url = (path: string) => pathToFileURL(join(root, path) + '/');
		integration.hooks['astro:config:done']({
			config: { root: url(''), outDir: url('dist'), cacheDir: url('.astro'), base: '/' },
		});
		const module = await plugin.load(file);
		const component = JSON.parse(module.slice('export default '.length, -1));
		expect(component.php).toContain('<?php');
		const { html } = await renderer.renderToStaticMarkup(
			component,
			{ title: 'Hello & welcome' },
			{
				default: '<b><?php echo "slot"; ?></b>',
			},
		);
		expect(html).toMatch(/^<\?php\n[\s\S]*\?>$/);
		expect(html).not.toContain('declare(strict_types=1)');
		const page = `Before${html}After`;
		const output = execFileSync(
			'php',
			['-r', `eval('?>' . base64_decode('${Buffer.from(page).toString('base64')}'));`],
			{ encoding: 'utf8' },
		);
		expect(output).toBe('Before<h1>Hello &amp; welcome</h1><b>slot</b>After');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('emits request-time PHP pages with props, nested default slots and deduplicated assets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-pages-'));
	try {
		await mkdir(join(root, 'src'), { recursive: true });
		await mkdir(join(root, 'dist/nested'), { recursive: true });
		await writeFile(
			join(root, 'src/Card.xph'),
			`---
export interface Props { title: string }
export interface Server { value: string }
---
<script server lang="php">return ['value' => $_GET['value'] ?? 'default'];</script>
<article><h1>{props.title}</h1><p>{server.value}</p><slot>fallback</slot></article>
<style>h1{color:navy}</style>`,
		);
		const integration = xph();
		let plugin: any;
		integration.hooks['astro:config:setup']({
			addRenderer: () => {},
			updateConfig: (config) => {
				plugin = config.vite.plugins[0];
			},
		});
		const url = (path: string) => pathToFileURL(join(root, path) + '/');
		const config = { root: url(''), outDir: url('dist'), cacheDir: url('.astro'), base: '/' };
		integration.hooks['astro:config:done']({ config });
		expect(plugin.load(join(root, 'src/Card.xph'))).toContain('src/Card');
		const component = { xph: true as const, id: 'src/Card' };
		const child = await renderer.renderToStaticMarkup(
			component,
			{ title: '\'</script><?php echo "unsafe";?>\\$é' },
			{},
		);
		const parent = await renderer.renderToStaticMarkup(
			component,
			{ title: 'Parent' },
			{ default: `<b>slot</b>${child.html}` },
		);
		await writeFile(
			join(root, 'dist/nested/index.html'),
			`<!doctype html><html><head></head><body>${parent.html}</body></html>`,
		);
		await writeFile(join(root, 'dist/index.html'), 'Static Astro');
		await integration.hooks['astro:build:done']({
			dir: config.outDir,
			logger: { info: () => {}, error: () => {} },
		});
		expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe('Static Astro');
		await expect(readFile(join(root, 'dist/nested/index.html'))).rejects.toThrow();
		const php = join(root, 'dist/nested/index.php');
		const source = await readFile(php, 'utf8');
		expect(source).not.toContain('base64_decode');
		expect(source).toContain("'../xph/xph.php'");
		expect(source).toContain("'src/Card'");
		execFileSync('php', ['-l', php]);
		const render = (value: string) =>
			execFileSync('php', ['-r', `$_GET['value'] = '${value}'; require ${JSON.stringify(php)};`], {
				encoding: 'utf8',
			});
		const html = render('first request');
		expect(html).toContain('first request');
		expect(render('second request')).toContain('second request');
		expect(html).toContain('<b>slot</b>');
		expect(html).toContain('&lt;?php');
		expect(html).toContain('&#039;&lt;/script&gt;&lt;?php echo &quot;unsafe&quot;;?&gt;\\$é');
		expect(html.match(/rel="stylesheet"/g)).toHaveLength(1);
		expect(html).not.toContain('<!--xph:');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('processes PHP templates before an adapter moves and renames the build output', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-adapter-'));
	try {
		await mkdir(join(root, 'dist'));
		await writeFile(join(root, 'Card.xph'), '<article><slot /></article>');
		const integration = xph({ entries: ['Card.xph'] });
		const url = (path: string) => pathToFileURL(join(root, path) + '/');
		const config = { root: url(''), outDir: url('dist'), cacheDir: url('.astro'), base: '/' };
		integration.hooks['astro:config:done']({ config });
		const child = await renderer.renderToStaticMarkup(
			{ xph: true, id: 'Card' },
			{},
			{
				default: '<?php echo "nested"; ?>',
			},
		);
		const parent = await renderer.renderToStaticMarkup(
			{ xph: true, id: 'Card' },
			{},
			{
				default: `<?php echo "slot"; ?>${child.html}`,
			},
		);
		await writeFile(
			join(root, 'dist/index.php.html'),
			`<?php echo "before"; ?>${parent.html}after`,
		);
		const args = { dir: config.outDir, logger: { info() {}, error() {} } };
		await integration.hooks['astro:build:generated'](args);
		await rename(join(root, 'dist'), join(root, 'theme'));
		await rename(join(root, 'theme/index.php.html'), join(root, 'theme/index.php'));
		await integration.hooks['astro:build:done'](args);
		const file = join(root, 'theme/index.php');
		expect(await readFile(file, 'utf8')).not.toContain('<!--xph:');
		expect(execFileSync('php', [file], { encoding: 'utf8' })).toBe(
			'before<article>slot<article>nested</article></article>after',
		);
		await expect(readFile(join(root, 'dist/xph/xph.php'))).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('rejects named slots and non-serializable props', async () => {
	const component = { xph: true as const, id: 'Card' };
	await expect(renderer.renderToStaticMarkup(component, { callback() {} }, {})).rejects.toThrow(
		'JSON',
	);
	await expect(
		renderer.renderToStaticMarkup(component, {}, { header: 'unsupported' }),
	).rejects.toThrow('default slot');
});

it('builds real Astro pages importing xph components without explicit entries', async () => {
	const { build } = await import('esbuild');
	const { copyFile, symlink } = await import('node:fs/promises');
	const { promisify } = await import('node:util');
	const { execFile } = await import('node:child_process');
	// Keep the temporary project under node_modules so bundled integration dependencies resolve.
	const root = await mkdtemp(join(process.cwd(), 'node_modules/.xph-astro-'));
	try {
		await mkdir(join(root, 'src/pages/nested'), { recursive: true });
		await mkdir(join(root, 'src/components'), { recursive: true });
		await mkdir(join(root, 'runtime'));
		await symlink(join(process.cwd(), 'packages/xph/node_modules'), join(root, 'node_modules'));
		await copyFile('packages/xph/runtime/runtime.php', join(root, 'runtime/runtime.php'));
		await build({
			entryPoints: ['packages/xph/src/astro-integration.ts', 'packages/xph/src/astro-renderer.ts'],
			outdir: join(root, 'integration'),
			bundle: true,
			packages: 'external',
			platform: 'node',
			format: 'esm',
		});
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await writeFile(
			join(root, 'src/components/Card.xph'),
			`---
export interface Props { title: string }
export interface Server { value: string }
---
<script server lang="php">return ['value' => $_GET['value'] ?? 'default'];</script>
<h1>{props.title}</h1><p>{server.value}</p><slot>fallback</slot><style>h1{color:navy}</style>
<script>document.documentElement.dataset.xph = "ready";</script>`,
		);
		await writeFile(
			join(root, 'src/pages/nested/index.astro'),
			`---
import Card from '../../components/Card.xph';
---
<html><head><title>Mixed page</title></head><body><Card title="Astro + PHP"><b>Astro slot</b></Card></body></html>`,
		);
		await writeFile(join(root, 'src/pages/index.astro'), '<h1>Static Astro</h1>');
		await writeFile(
			join(root, 'build.mjs'),
			`import { build } from 'astro';
import xph from './integration/astro-integration.js';
await build({ root: new URL('./', import.meta.url), configFile: false, integrations: [xph()], logLevel: 'silent' });`,
		);
		await promisify(execFile)(process.execPath, [join(root, 'build.mjs')], {
			cwd: root,
			timeout: 60000,
		});
		expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toContain('Static Astro');
		const page = join(root, 'dist/nested/index.php');
		const html = execFileSync(
			'php',
			['-r', `$_GET['value']='request-time';require ${JSON.stringify(page)};`],
			{ encoding: 'utf8' },
		);
		expect(html).toContain('Astro + PHP');
		expect(html).toContain('request-time');
		expect(html).toContain('<b>Astro slot</b>');
		expect(html).toContain('rel="stylesheet"');
		const script = html.match(/<script type="module" src="([^"]+)"><\/script>/);
		expect(script).not.toBeNull();
		expect(await readFile(join(root, 'dist', script![1]), 'utf8')).toContain('dataset.xph');
		expect(html).toContain('data-xph-');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
