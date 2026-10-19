import { describe, it, expect } from 'vitest';
import xph from '../packages/xph/src/astro-integration.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
const logger = { info: () => {}, error: () => {} };
async function fixture(run: (root: string, config: any) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), 'xph-astro-'));
	try {
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(
			join(root, 'src/Card.xph'),
			'---\nexport interface Props { title:string }\n---\n<h1>{props.title}</h1><style>h1{color:navy}</style>',
		);
		const url = (path: string) => pathToFileURL(join(root, path) + '/');
		await run(root, {
			root: url(''),
			outDir: url('dist'),
			cacheDir: url('.astro'),
			base: '/site/',
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
describe('Astro integration', () => {
	it('exports the integration without changing normal Astro output', async () =>
		fixture(async (root, config) => {
			const integration = xph({ entries: ['src/Card.xph'] });
			integration.hooks['astro:config:done']({ config });
			await mkdir(join(root, 'dist/assets'), { recursive: true });
			await writeFile(join(root, 'dist/index.html'), '<h1>Astro</h1>');
			await writeFile(join(root, 'dist/assets/astro.js'), 'console.log("Astro");');
			await integration.hooks['astro:build:done']({ dir: config.outDir, logger });
			expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe('<h1>Astro</h1>');
			expect(await readFile(join(root, 'dist/assets/astro.js'), 'utf8')).toContain('Astro');
			const manifest = JSON.parse(await readFile(join(root, 'dist/xph/manifest.json'), 'utf8'));
			expect(manifest['src/Card'].assets[0].url).toMatch(/^\/site\/xph\/assets\//);
			const php = `require ${JSON.stringify(join(root, 'dist/xph/xph.php'))};echo \\Xph\\render('src/Card',['title'=>'Astro + PHP']);`;
			expect(execFileSync('php', ['-r', php], { encoding: 'utf8' })).toContain('Astro + PHP');
		}));
	it('uses the final build directory and a custom namespace/CDN', async () =>
		fixture(async (root, config) => {
			const integration = xph({
				entries: ['src/Card.xph'],
				directory: 'backend/views',
				assetBase: 'https://cdn.example.com/ui/',
			});
			integration.hooks['astro:config:done']({ config });
			const dir = pathToFileURL(join(root, 'client/'));
			await integration.hooks['astro:build:done']({ dir, logger });
			const manifest = JSON.parse(
				await readFile(join(root, 'client/backend/views/manifest.json'), 'utf8'),
			);
			expect(manifest['src/Card'].assets[0].url).toMatch(/^https:\/\/cdn.example.com\/ui\//);
		}));
	it('fails the Astro build on source diagnostics', async () =>
		fixture(async (root, config) => {
			const integration = xph({ entries: ['src/Card.xph'] });
			integration.hooks['astro:config:done']({ config });
			await writeFile(join(root, 'src/Card.xph'), '<p>{missing}</p>');
			await expect(
				integration.hooks['astro:build:done']({ dir: config.outDir, logger }),
			).rejects.toThrow('Cannot find name');
		}));
	it.each([
		'',
		'../',
		'../dist',
		'/tmp/xph',
		'xph/../assets',
		'xph//a',
		'xph?x',
		'C:/tmp',
		'xph\\a',
	])('rejects an unsafe output namespace %s', (directory) =>
		expect(() => xph({ entries: ['src/Card.xph'], directory })).toThrow('subdirectory'),
	);
	it('requires explicit entries', () => expect(() => xph({ entries: [] })).toThrow('entries'));
	it('watches dependencies, serves only assets, and removes listeners at shutdown', async () =>
		fixture(async (root, config) => {
			const integration = xph({ entries: ['src/Card.xph'] });
			integration.hooks['astro:config:done']({ config });
			const watcher = Object.assign(new EventEmitter(), { add: (_files: unknown) => {} }),
				httpServer = new EventEmitter();
			let handler: any;
			let reloads = 0;
			const server = {
				watcher,
				httpServer,
				ws: {
					send: () => {
						reloads++;
					},
				},
				middlewares: {
					use: (value: any) => {
						handler = value;
					},
				},
			};
			await integration.hooks['astro:server:setup']({ server, logger });
			const manifest = JSON.parse(await readFile(join(root, '.astro/xph/manifest.json'), 'utf8'));
			const url = manifest['src/Card'].assets[0].url;
			const css = await new Promise<string>((done, reject) =>
				handler(
					{ url, method: 'GET' },
					{ setHeader: () => {}, end: (body: Buffer) => done(body.toString()) },
					() => reject(new Error('Asset not served')),
				),
			);
			expect(css).toContain('color:navy');
			let passed = false;
			handler({ url: '/site/xph/runtime.php', method: 'GET' }, {}, () => {
				passed = true;
			});
			expect(passed).toBe(true);
			watcher.emit('all', 'add', join(root, '.astro/xph.xph-staging/assets/123456789abc.css'));
			await new Promise((done) => setTimeout(done, 150));
			expect(reloads).toBe(0);
			await writeFile(join(root, 'src/Card.xph'), '<p>updated</p>');
			watcher.emit('all', 'change', join(root, 'src/Card.xph'));
			for (let i = 0; i < 100 && !reloads; i++) await new Promise((done) => setTimeout(done, 25));
			expect(reloads).toBe(1);
			expect(await readFile(join(root, '.astro/xph/components/src/Card.php'), 'utf8')).toContain(
				'updated',
			);
			httpServer.emit('close');
			expect(watcher.listenerCount('all')).toBe(0);
		}));
});
