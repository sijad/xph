#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { build } from './build.js';
import { check } from './check.js';
import type { Config, Diagnostic } from './types.js';
export async function loadConfig(path = resolve('xph.config.ts')): Promise<Config> {
	const code = await readFile(path, 'utf8');
	const output = await bundle({
		stdin: { contents: code, resolveDir: dirname(path), loader: 'ts' },
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
	});
	const mod = await import(
		'data:text/javascript;base64,' + Buffer.from(output.outputFiles![0].text).toString('base64')
	);
	return { root: dirname(path), ...mod.default };
}
function report(diagnostics: Diagnostic[]) {
	for (const d of diagnostics)
		console.error(`${d.filename ?? ''}:${d.start}: ${d.source}: ${d.message}`);
	return diagnostics.some((d) => d.severity === 'error');
}
async function main() {
	const command = process.argv[2] ?? 'build';
	if (command === 'lsp') {
		const { start } = await import('./lsp.js' as string);
		let config: Config = { entries: [] };
		try {
			config = await loadConfig();
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error((e as Error).message);
		}
		start(process.stdin, process.stdout, config);
		return;
	}
	if (!['build', 'dev', 'check'].includes(command))
		throw new Error('Usage: xph <build|dev|check|lsp> [config.ts]');
	const config = await loadConfig(resolve(process.argv[3] ?? 'xph.config.ts'));
	if (command === 'check') {
		if (report(await check(config))) process.exitCode = 1;
		return;
	}
	const rebuild = async () => {
		try {
			const result = await build(config);
			const failed = report(result.diagnostics);
			console.error(
				failed ? 'Build failed.' : `Built ${result.components.size} components in ${result.outDir}`,
			);
			if (command === 'build' && failed) process.exitCode = 1;
		} catch (e) {
			console.error((e as Error).message);
			if (command === 'build') process.exitCode = 1;
		}
	};
	await rebuild();
	if (command === 'dev') {
		const { watch } = await import('chokidar');
		const watcher = watch(config.root ?? '.', {
			ignored: (path) =>
				/(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(path) ||
				path.startsWith(resolve(config.root ?? '.', config.outDir ?? 'dist')),
			ignoreInitial: true,
		});
		let timer: ReturnType<typeof setTimeout>,
			queue = Promise.resolve();
		watcher.on('all', () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				queue = queue.then(rebuild);
			}, 100);
		});
		console.error('Watching for changes. Run the example PHP preview server separately.');
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
	main().catch((e) => {
		console.error(e.message);
		process.exitCode = 1;
	});
