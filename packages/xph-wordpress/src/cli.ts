#!/usr/bin/env node
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { watch } from 'chokidar';
import { diagnosticLocation } from 'xph';
import { build, type Config } from './build.js';

async function main() {
	const [command = 'build', ...args] = process.argv.slice(2);
	if (!['build', 'dev', 'check'].includes(command) || args.length > 1 || args[0]?.startsWith('-'))
		throw new Error('Usage: xph-wordpress <build|dev|check> [xph.config.ts]');
	const path = resolve(args[0] ?? 'xph.config.ts');
	const root = dirname(path);
	async function load(): Promise<Config> {
		const result = await bundle({
			stdin: { contents: await readFile(path, 'utf8'), resolveDir: root, loader: 'ts' },
			bundle: true,
			write: false,
			platform: 'node',
			format: 'esm',
			packages: 'external',
		});
		const temporary = resolve(root, '.xph-wordpress-config-' + randomUUID() + '.mjs');
		try {
			await writeFile(temporary, result.outputFiles[0].text);
			const config = (await import(pathToFileURL(temporary).href)).default;
			return { ...config, root: resolve(root, config.root ?? '.') };
		} finally {
			await rm(temporary, { force: true });
		}
	}
	let config = await load();
	const outDir = resolve(config.root!, config.outDir ?? 'dist');
	const excluded = (path: string) =>
		path === outDir ||
		path.startsWith(outDir + sep) ||
		/(?:^|[/\\])(?:node_modules|\.git|\.xph)(?:[/\\]|$)/.test(path) ||
		/\.xph-wordpress-config-/.test(path);
	async function run() {
		try {
			config = await load();
			if (resolve(config.root!, config.outDir ?? 'dist') !== outDir)
				throw new Error('Output directory changed. Restart xph-wordpress dev.');
			const result = await build(config, { write: command !== 'check', dev: command === 'dev' });
			const sources = new Map<string, string | undefined>();
			for (const d of result.diagnostics)
				console.error(`${diagnosticLocation(d, sources)}: ${d.severity}: ${d.message}`);
			const errors = result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
			if (errors.length) throw new Error(errors.join('\n'));
			console.log(
				command === 'check'
					? 'WordPress block check passed.'
					: `Built ${Object.keys(result.signatures).length} WordPress blocks.`,
			);
		} catch (e) {
			console.error((e as Error).message);
			if (command !== 'dev') process.exitCode = 1;
			else {
				try {
					await writeFile(
						resolve(outDir, 'dev.json'),
						JSON.stringify({ errors: [(e as Error).message] }),
					);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
				}
			}
		}
	}
	if (command !== 'dev') {
		await run();
		return;
	}
	// Watch the project, including imported metadata/config modules outside srcDir.
	let timer: ReturnType<typeof setTimeout>;
	let queue = Promise.resolve();
	const watcher = watch(config.root!, {
		ignoreInitial: true,
		followSymlinks: false,
		ignored: excluded,
	});
	watcher.on('all', () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			queue = queue.then(run);
		}, 100);
	});
	await new Promise<void>((resolve) => watcher.once('ready', resolve));
	await run();
	console.log('Watching XPH and metadata. Open a block in the WordPress editor for live preview.');
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
