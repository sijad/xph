import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import renderer from '../packages/xph/src/astro-renderer.js';
import xph from '../packages/xph/src/astro-integration.js';

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
			{ title: '</script><?php echo "unsafe";?>' },
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
		expect(html.match(/rel="stylesheet"/g)).toHaveLength(1);
		expect(html).not.toContain('<!--xph:');
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
