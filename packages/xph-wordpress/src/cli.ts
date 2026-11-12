#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLogger, dev, inside } from './dev.js';
import {
	diagnosticLocation,
	findConfig,
	loadConfig,
	stylesOnly as stylesOnlyBuild,
	type Diagnostic,
} from 'xph';
import { build, createBuilder, type Config, type Result } from './build.js';

const logger = createLogger('xph-wordpress');

/** Block registrations are part of the page too. */
const stylesOnly = (before: Result, after: Result) =>
	JSON.stringify(before.signatures) === JSON.stringify(after.signatures) &&
	stylesOnlyBuild(before, after);

async function main() {
	const [command = 'build', ...args] = process.argv.slice(2);
	const skipPhpCheck = args.includes('--skip-php-check');
	const paths = args.filter((arg) => !arg.startsWith('--'));
	if (
		!['build', 'dev', 'check'].includes(command) ||
		paths.length > 1 ||
		args.some((arg) => arg.startsWith('--') && arg !== '--skip-php-check') ||
		(skipPhpCheck && command === 'check')
	)
		throw new Error(
			'Usage: xph-wordpress <build|dev> [config.ts] [--skip-php-check] | xph-wordpress check [config.ts]',
		);
	const path = paths[0]
		? resolve(paths[0])
		: (findConfig(process.cwd()) ?? resolve('xph.config.ts'));
	let config = await loadConfig(path);
	const root = resolve(config.root ?? '.');
	const outDir = resolve(root, config.outDir ?? 'dist');
	const srcDir = resolve(root, config.srcDir ?? 'src');

	/** Log warnings, and return the errors as one message. */
	function report(diagnostics: Diagnostic[]): string | undefined {
		const sources = new Map<string, string | undefined>();
		const errors: string[] = [];
		for (const d of diagnostics) {
			const location = diagnosticLocation(d, sources);
			const message = `${location.startsWith(root + sep) ? location.slice(root.length + 1) : location} ${d.message}`;
			if (d.severity === 'error') errors.push(message);
			else logger.warn(message);
		}
		return errors.length ? errors.join('\n') : undefined;
	}
	const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
	const summary = (result: Result, started: number) =>
		`${count(Object.keys(result.signatures).length, 'block')}, ${result.compiled} of ${result.components.size} components compiled ${logger.dim(`in ${Math.round(performance.now() - started)}ms`)}`;

	if (command !== 'dev') {
		const started = performance.now();
		const result = await build(config, { write: command !== 'check', skipPhpCheck });
		const errors = report(result.diagnostics);
		if (errors) {
			logger.error(errors);
			process.exitCode = 1;
		} else if (command === 'check') logger.info('check passed');
		else logger.info(`built ${summary(result, started)} → ${logger.dim(outDir)}`);
		return;
	}

	let rebuild = createBuilder(config);
	let previous: Result | undefined;
	const server = await dev({
		root,
		paths: [srcDir, path],
		logger,
		// outDir may be inside srcDir.
		ignore: (file) => inside(outDir, file),
		async build({ sourceOnly, changed, client, watch }) {
			if (changed.includes(path)) {
				const next: Config = await loadConfig(path);
				const nextRoot = resolve(next.root ?? '.');
				if (
					resolve(nextRoot, next.outDir ?? 'dist') !== outDir ||
					resolve(nextRoot, next.srcDir ?? 'src') !== srcDir
				)
					throw new Error('Source or output directory changed. Restart xph-wordpress dev.');
				config = next;
				rebuild = createBuilder(config);
				logger.info('config changed, rebuilding');
			}
			const started = performance.now();
			const result = await rebuild({ dev: true, client, sourceOnly, changed, skipPhpCheck });
			watch(result.inputs);
			const errors = report(result.diagnostics);
			if (errors) throw new Error(errors);
			if (!changed.length) logger.info(`built ${summary(result, started)}`);
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
		async onError(message) {
			// The block editor preview polls dev.json for errors.
			try {
				await writeFile(resolve(outDir, 'dev.json'), JSON.stringify({ errors: [message] }));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			}
		},
	});
	const stop = () => void server.close().then(() => process.exit());
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}

main().catch((error) => {
	logger.error(error.message);
	process.exitCode = 1;
});
