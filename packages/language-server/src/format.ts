import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { extractPHP } from 'xph';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'prettier';

/** Keep PHP opaque to Astro's JavaScript parser, including apparent closing tags in strings. */
export async function formatAstro(
	source: string,
	filename: string,
	options: { tabSize: number; insertSpaces: boolean },
	log: (message: string) => void = () => {},
) {
	const prettierPath = resolveProjectPackage('prettier', filename);
	const astroPath = resolveProjectPackage('prettier-plugin-astro', filename);
	if (!prettierPath || !astroPath) {
		log(
			'Astro formatting requires project dependencies: prettier (3+) and prettier-plugin-astro. PHP formatting remains available.',
		);
		return source;
	}
	const [prettierModule, astroModule] = await Promise.all([
		import(pathToFileURL(prettierPath).href),
		import(pathToFileURL(astroPath).href),
	]);
	const prettier: typeof import('prettier') = prettierModule.default ?? prettierModule;
	const astro: Plugin = astroModule.default ?? astroModule;
	if (Number(prettier.version.split('.')[0]) < 3)
		throw new Error('xph formatting requires project Prettier 3 or newer.');
	const { format, resolveConfig, resolveConfigFile } = prettier;
	const { blocks, diagnostics } = extractPHP(source);
	if (diagnostics.length) throw new Error(diagnostics[0].message);
	let prefix = 'xph-php-format';
	while (source.includes(prefix)) prefix += 'x';
	let masked = source;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		masked =
			masked.slice(0, block.start) + `<div data-${prefix}="${i}"></div>` + masked.slice(block.end);
	}
	const config = await resolveConfig(filename, { editorconfig: true });
	const configFile = await resolveConfigFile(filename);
	const configRequire = createRequire(configFile ?? filename);
	const plugins = (config?.plugins ?? [])
		.filter((plugin) => plugin !== 'prettier-plugin-astro')
		.map((plugin) => (typeof plugin === 'string' ? configRequire.resolve(plugin) : plugin));
	let formatted = await format(masked, {
		tabWidth: options.tabSize,
		useTabs: !options.insertSpaces,
		endOfLine: source.includes('\r\n') ? 'crlf' : 'lf',
		...config,
		filepath: filename,
		parser: 'astro',
		plugins: [
			...plugins,
			{
				parsers: astro.parsers,
				printers: astro.printers,
				options: astro.options,
				defaultOptions: astro.defaultOptions,
			},
		],
	});
	// Restore every PHP block exactly once; never risk emitting a placeholder into source.
	for (let i = 0; i < blocks.length; i++) {
		const marker = `<div data-${prefix}="${i}"></div>`;
		if (formatted.split(marker).length !== 2)
			throw new Error('Astro formatter did not preserve a PHP block.');
		formatted = formatted.replace(marker, (marker, offset: number) => {
			const block = blocks[i];
			if (!block.code.includes('\n')) return source.slice(block.start, block.end);
			const base = /^[ \t]*/.exec(
				formatted.slice(formatted.lastIndexOf('\n', offset - 1) + 1, offset),
			)![0];
			const unit =
				(config?.useTabs ?? !options.insertSpaces)
					? '\t'
					: ' '.repeat(config?.tabWidth ?? options.tabSize);
			const eol = formatted.includes('\r\n') ? '\r\n' : '\n';
			const opening = source.slice(block.start, block.contentStart);
			const closing = source.slice(block.contentStart + block.code.length, block.end);
			const code = block.code.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
			const indented = indentPHP(code, base + unit).replace(/\r?\n/g, eol);
			return opening + eol + indented + eol + base + closing;
		});
	}
	return formatted;
}

// Do not fall back to globally injected NODE_PATH modules or the language server's packages.
function resolveProjectPackage(name: string, filename: string): string | undefined {
	let directory = dirname(filename);
	while (true) {
		if (existsSync(join(directory, 'node_modules', name, 'package.json'))) {
			return createRequire(filename).resolve(name, { paths: [directory] });
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

// Shift code lines without changing the contents of multiline PHP literals.
function indentPHP(code: string, indentation: string) {
	const lines = code.split(/\r?\n/);
	const protectedLines = new Set<number>();
	let quote = '';
	let comment = false;
	let heredoc = '';
	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		if (quote || heredoc) protectedLines.add(line);
		if (heredoc) {
			const end = new RegExp('^[ \\t]*' + heredoc + '(?=[; ,)\\r\\n]|$)').exec(text);
			if (!end) continue;
			heredoc = '';
		}
		for (let i = 0; i < text.length; i++) {
			if (quote) {
				if (text[i] === '\\') i++;
				else if (text[i] === quote) quote = '';
			} else if (comment) {
				if (text.startsWith('*/', i)) {
					comment = false;
					i++;
				}
			} else if (text.startsWith('//', i) || (text[i] === '#' && text[i + 1] !== '[')) {
				break;
			} else if (text.startsWith('/*', i)) {
				comment = true;
				i++;
			} else if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
				quote = text[i];
			} else if (text.startsWith('<<<', i)) {
				const match = /^<<<[ \t]*['"]?([a-zA-Z_]\w*)['"]?[ \t]*$/.exec(text.slice(i));
				if (match) {
					heredoc = match[1];
					break;
				}
			}
		}
	}
	const margin = Math.min(
		...lines.flatMap((line, i) =>
			line.trim() && !protectedLines.has(i) ? [/^[ \t]*/.exec(line)![0].length] : [],
		),
	);
	return lines
		.map((line, i) =>
			protectedLines.has(i) || !line.trim() ? line : indentation + line.slice(margin),
		)
		.join('\n');
}
