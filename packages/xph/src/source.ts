import ts from 'typescript';
import type { Diagnostic } from './types.js';
export function position(source: string, offset: number) {
	const lines = source.slice(0, offset).split('\n');
	return { line: lines.length - 1, character: lines.at(-1)!.length };
}
export function byteOffset(source: string, bytes: number) {
	let size = 0,
		offset = 0;
	for (const char of source) {
		if (size >= bytes) break;
		size += Buffer.byteLength(char);
		offset += char.length;
	}
	return offset;
}
export interface PHPBlock {
	code: string;
	start: number;
	end: number;
	contentStart: number;
}
// PHP strings, comments and heredocs may contain apparent closing HTML tags.
function phpEnd(source: string, from: number): number {
	let i = from;
	while (i < source.length) {
		if (
			source.slice(i, i + 8).toLowerCase() === '</script' &&
			/^<\/script\s*>/i.test(source.slice(i))
		)
			return i;
		const c = source[i];
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			i++;
			while (i < source.length) {
				if (source[i] === '\\') i += 2;
				else if (source[i++] === quote) break;
			}
			continue;
		}
		if (source.startsWith('/*', i)) {
			const end = source.indexOf('*/', i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		if (source.startsWith('//', i) || (c === '#' && source[i + 1] !== '[')) {
			const end = source.indexOf('\n', i);
			i = end < 0 ? source.length : end + 1;
			continue;
		}
		if (source.startsWith('<<<', i)) {
			const match = /^<<<[ \t]*['"]?([a-zA-Z_]\w*)['"]?[^\r\n]*\r?\n/.exec(source.slice(i));
			if (match) {
				i += match[0].length;
				const end = new RegExp('^[ \\t]*' + match[1] + '(?=[; ,)\\r\\n]|$)', 'm').exec(
					source.slice(i),
				);
				i = end ? i + end.index + end[0].length : source.length;
				continue;
			}
		}
		i++;
	}
	return -1;
}
export function extractPHP(source: string): {
	masked: string;
	blocks: PHPBlock[];
	diagnostics: Diagnostic[];
} {
	const blocks: PHPBlock[] = [],
		diagnostics: Diagnostic[] = [];
	let masked = source;
	// Scan HTML tags, skipping frontmatter, comments, quoted attributes and raw text bodies.
	let i = source.startsWith('---') ? source.indexOf('\n---', 3) + 4 : 0;
	while (i < source.length) {
		if (source.startsWith('<!--', i)) {
			const end = source.indexOf('-->', i + 4);
			i = end < 0 ? source.length : end + 3;
			continue;
		}
		if (source[i] === '{') {
			const text = source.slice(i + 1),
				prefix = 'const __ = (';
			const parsed = ts.createSourceFile(
				'expression.tsx',
				prefix + text,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			const statement = parsed.statements[0];
			if (statement && ts.isVariableStatement(statement)) {
				const init = statement.declarationList.declarations[0]?.initializer;
				const expression = init && ts.isParenthesizedExpression(init) ? init.expression : init;
				if (expression) {
					i += 1 + Math.max(1, expression.end - prefix.length);
					if (source[i] === '}') i++;
					continue;
				}
			}
		}
		if (source[i] !== '<' || !/[a-zA-Z]/.test(source[i + 1] ?? '')) {
			i++;
			continue;
		}
		const start = i++;
		let quote = '';
		while (i < source.length) {
			const c = source[i++];
			if (quote) {
				if (c === quote) quote = '';
			} else if (c === '"' || c === "'") quote = c;
			else if (c === '>') break;
		}
		const tag = source.slice(start, i);
		if (!/^<(script|style)\b/i.test(tag)) continue;
		const attrs = new Map<string, string | true>();
		const attrText = tag.replace(/^<\w+/, '');
		for (const attr of attrText.matchAll(
			/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
		))
			attrs.set(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? true);
		const server = /^<script\b/i.test(tag) && attrs.has('server');
		if (!server) {
			const closing = new RegExp(/^<style/i.test(tag) ? '</style\\s*>' : '</script\\s*>', 'i').exec(
				source.slice(i),
			);
			i = closing ? i + closing.index + closing[0].length : source.length;
			continue;
		}
		if (attrs.get('lang') !== 'php')
			diagnostics.push({
				message: 'Server scripts require lang="php".',
				severity: 'error',
				start,
				end: i,
				source: 'xph',
			});
		const end = phpEnd(source, i);
		if (end < 0) {
			diagnostics.push({
				message: 'Unterminated PHP server block.',
				severity: 'error',
				start,
				end: source.length,
				source: 'xph',
			});
			break;
		}
		const close = source.indexOf('>', end) + 1;
		blocks.push({ code: source.slice(i, end), start, end: close, contentStart: i });
		// Keep UTF-8 byte length AND UTF-16 length: replace each code point with an equal-width blank.
		const blank = source
			.slice(start, close)
			.replace(/[^\r\n]/gu, (c) =>
				c.length === 2
					? '𐀀'
					: Buffer.byteLength(c) === 3
						? '\u3000'
						: Buffer.byteLength(c) === 2
							? '\u00a0'
							: ' ',
			);
		// A comment keeps Astro from trimming Unicode-width placeholders into visible text.
		masked = masked.slice(0, start) + '<!--' + blank.slice(4, -3) + '-->' + masked.slice(close);
		i = close;
	}
	return { masked, blocks, diagnostics };
}
