#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build, createBuilder, stylesOnly, type BuildOptions, type BuildResult } from './build.js';
import { check } from './check.js';
import { findConfig, loadConfig } from './config.js';
import { diagnosticLocation } from './source.js';
import type { Config, Diagnostic } from './types.js';
function report(diagnostics: Diagnostic[]) {
	const sources = new Map<string, string | undefined>();
	for (const d of diagnostics)
		console.error(`${diagnosticLocation(d, sources)}: ${d.source}: ${d.message}`);
	return diagnostics.some((d) => d.severity === 'error');
}
async function main() {
	const command = process.argv[2] ?? 'build';
	const args = process.argv.slice(3);
	const compactPHP = args.includes('--compact-php')
		? true
		: args.includes('--no-compact-php')
			? false
			: undefined;
	const skipPhpCheck = args.includes('--skip-php-check');
	const paths = args.filter((arg) => !arg.startsWith('--'));
	if (
		paths.length > 1 ||
		args.some(
			(arg) =>
				arg.startsWith('--') &&
				!['--skip-php-check', '--compact-php', '--no-compact-php'].includes(arg),
		) ||
		(skipPhpCheck && command !== 'build' && command !== 'dev')
	)
		throw new Error(
			'Usage: xph <build|dev> [config.ts] [--skip-php-check] | xph <check|lsp> [config.ts]',
		);
	if (command === 'lsp') {
		const { start } = await import('./lsp.js');
		const path = configPath(paths[0]);
		let config: Config = { srcDir: 'src' };
		try {
			config = await loadConfig(path);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error((e as Error).message);
		}
		start(process.stdin, process.stdout, config);
		return;
	}
	if (!['build', 'dev', 'check'].includes(command))
		throw new Error('Usage: xph <build|dev|check|lsp> [config.ts]');
	const config = await loadConfig(configPath(paths[0]));
	if (command === 'check') {
		if (report(await check(config))) process.exitCode = 1;
		return;
	}
	if (command === 'dev') return develop(config, configPath(paths[0]), { skipPhpCheck, compactPHP });
	try {
		const result = await build(config, { skipPhpCheck, compactPHP });
		const failed = report(result.diagnostics);
		console.error(
			failed
				? 'Build failed.'
				: `Compiled ${result.compiled} of ${result.components.size} components in ${result.outDir}`,
		);
		if (failed) process.exitCode = 1;
	} catch (e) {
		console.error((e as Error).message);
		process.exitCode = 1;
	}
}

/** Rebuild on changes to srcDir or the config, and live reload open pages. */
async function develop(config: Config, path: string, options: BuildOptions) {
	const { createLogger, dev, inside } = await import('./dev.js');
	const logger = createLogger('xph');
	const root = resolve(config.root ?? '.');
	const srcDir = resolve(root, config.srcDir ?? 'src');
	const outDir = resolve(root, config.outDir ?? 'dist');
	let rebuild = createBuilder(config);
	let previous: BuildResult | undefined;
	const server = await dev({
		root,
		paths: [srcDir, path],
		logger,
		// outDir, or the directory it is staged in, may be inside srcDir.
		ignore: (file) => inside(outDir, file) || file.startsWith(outDir + '.xph-'),
		async build({ sourceOnly, changed, client, watch }) {
			if (changed.includes(path)) {
				const next = await loadConfig(path);
				const nextRoot = resolve(next.root ?? '.');
				if (
					resolve(nextRoot, next.outDir ?? 'dist') !== outDir ||
					resolve(nextRoot, next.srcDir ?? 'src') !== srcDir
				)
					throw new Error('Source or output directory changed. Restart xph dev.');
				rebuild = createBuilder(next);
				logger.info('config changed, rebuilding');
			}
			const started = performance.now();
			const result = await rebuild({ ...options, sourceOnly, changed, client });
			watch(result.inputs);
			const sources = new Map<string, string | undefined>();
			const errors: string[] = [];
			for (const d of result.diagnostics) {
				const location = diagnosticLocation(d, sources);
				const message = `${location.startsWith(root + sep) ? location.slice(root.length + 1) : location} ${d.message}`;
				if (d.severity === 'error') errors.push(message);
				else logger.warn(message);
			}
			if (errors.length) throw new Error(errors.join('\n'));
			if (!changed.length)
				logger.info(
					`compiled ${result.compiled} of ${result.components.size} components ${logger.dim(`in ${Math.round(performance.now() - started)}ms`)} → ${logger.dim(outDir)}`,
				);
			const before = previous;
			previous = result;
			// Editing a <style> block changes only the component's stylesheet, not its PHP.
			return before &&
				changed.length > 0 &&
				changed.every((file) => /\.(?:xph|css)$/.test(file)) &&
				stylesOnly(before, result)
				? 'styles'
				: 'reload';
		},
	});
	const stop = () => void server.close().then(() => process.exit());
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
	main().catch((e) => {
		console.error(e.message);
		process.exitCode = 1;
	});

/** An explicit config, or xph.config.ts in the working directory. */
function configPath(path?: string): string {
	return path ? resolve(path) : (findConfig(process.cwd()) ?? resolve('xph.config.ts'));
}
