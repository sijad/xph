import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { BuildResult } from 'xph';
import { templateDefinition } from './metadata.js';
import { phpValue } from './php.js';

/** Add theme entrypoints only after compiling the shared component graph. */
export async function themeFiles(
	src: string,
	files: Map<string, string | Uint8Array>,
	namespace: string,
	result: BuildResult,
	error: (message: string, filename?: string) => void,
	autoload: string[] = [],
) {
	const theme = join(src, 'theme');
	if (
		src === result.outDir ||
		src.startsWith(result.outDir + sep) ||
		result.outDir.startsWith(theme + sep)
	)
		throw new Error('Theme outDir must not contain srcDir or be inside srcDir/theme.');
	const entries = new Map<string, string>();
	async function discover(directory: string) {
		let children;
		try {
			children = await readdir(directory, { withFileTypes: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT' && directory === theme) return;
			throw e;
		}
		for (const child of children) {
			const file = join(directory, child.name);
			if (child.isDirectory()) await discover(file);
			else if (child.isFile()) {
				const name = relative(theme, file).split(sep).join('/');
				const output = name.replace(/\.xph$/, '.php');
				if (
					entries.has(output) ||
					[...files.keys(), ...entries.keys()].some(
						(path) =>
							path === output || path.startsWith(output + '/') || output.startsWith(path + '/'),
					) ||
					[
						'.xph-wordpress-files.json',
						'manifest.php',
						'runtime.php',
						'register.php',
						'dev.json',
					].includes(output) ||
					(output === 'functions.php' && !['functions.xph', 'functions.php'].includes(name))
				) {
					error('Theme output collision: ' + output, file);
					continue;
				}
				entries.set(output, file);
			}
		}
	}
	await discover(theme);
	// functions.php is always owned by XPH; require_once also guards direct template execution.
	files.set(
		'functions.php',
		`<?php\nif (defined('${namespace}_bootstrapped')) return;\ndefine('${namespace}_bootstrapped', true);\nrequire_once __DIR__ . '/register.php';\n` +
			autoload.map((path) => `require_once __DIR__ . ${phpValue('/' + path)};\n`).join(''),
	);
	for (const [output, file] of entries) {
		if (!file.endsWith('.xph')) {
			if (output === 'functions.php') {
				files.set(
					'functions.php',
					files.get('functions.php') + `require_once __DIR__ . '/theme-functions.php';\n`,
				);
				if (
					[...entries.keys(), ...files.keys()].some(
						(path) => path === 'theme-functions.php' || path.startsWith('theme-functions.php/'),
					)
				) {
					error('Theme output collision: theme-functions.php', file);
					continue;
				}
				files.set('theme-functions.php', await readFile(file));
				continue;
			}
			files.set(output, await readFile(file));
			continue;
		}
		const key = relative(src, file)
			.split(sep)
			.join('/')
			.replace(/\.xph$/, '');
		let metadata;
		try {
			metadata = await templateDefinition(file);
		} catch (e) {
			error((e as Error).message, file);
			continue;
		}
		const bootstrap = output === 'functions.php';
		let header = '';
		if (metadata !== undefined) {
			if (bootstrap) {
				error('functions.xph cannot export template metadata.', file);
				continue;
			}
			if (
				!metadata ||
				typeof metadata.name !== 'string' ||
				!metadata.name.trim() ||
				[...metadata.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
				metadata.name.includes('*/') ||
				metadata.name.includes('?>') ||
				(metadata.postTypes !== undefined && !Array.isArray(metadata.postTypes)) ||
				!(metadata.postTypes ?? ['page']).length ||
				(metadata.postTypes ?? ['page']).some(
					(type) => typeof type !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(type),
				)
			) {
				error(
					'Invalid template metadata: supply a nonempty name and valid postTypes without header-breaking characters.',
					file,
				);
				continue;
			}
			header = `/*\nTemplate Name: ${metadata.name}\nTemplate Post Type: ${(metadata.postTypes ?? ['page']).join(', ')}\n*/\n`;
		}
		if (bootstrap) {
			files.set(
				'functions.php',
				files.get('functions.php') +
					`ob_start();\ntry { \\${namespace}\\render(${phpValue(key)}, []); } finally { ob_end_clean(); }\n`,
			);
			continue;
		}
		const depth = output.split('/').length;
		files.set(
			output,
			`<?php\n${header}require_once dirname(__FILE__, ${depth}) . '/functions.php';\n(function () {\n$renderer = \\${namespace}\\renderer([${phpValue(key)}]);\nob_start();\ntry { $html = $renderer->render(${phpValue(key)}, []); $html = ob_get_clean() . $html; } catch (\\Throwable $error) { ob_end_clean(); throw $error; }\n$styles = $renderer->styles();\n$scripts = $renderer->scripts();\n$html = stripos($html, '</head>') !== false ? preg_replace_callback('~</head>~i', static fn($match) => $styles . $match[0], $html, 1) : $styles . $html;\n$html = stripos($html, '</body>') !== false ? preg_replace_callback('~</body>~i', static fn($match) => $scripts . $match[0], $html, 1) : $html . $scripts;\necho $html;\n})();\n`,
		);
	}
}
