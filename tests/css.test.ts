import { expect, it } from 'vitest';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { position } from '../packages/xph/src/source.js';

const uri = 'file:///styles.xph';
function document(source: string) {
	const server = new LanguageServer(() => {});
	const offset = source.indexOf('|');
	const text = source.replace('|', '');
	server.documents.set(uri, { text, version: 1 });
	const params = { textDocument: { uri }, position: position(text, offset) };
	return { server, params, text, offset };
}

it.each([
	['<style>.card { col| }</style>', 'color'],
	['<style>.card { display: fl| }</style>', 'flex'],
	['<style>.card:hov| {}</style>', ':hover'],
	['<style>@med|</style>', '@media'],
	['<style lang="scss">.card { col| }</style>', 'color'],
	["<style lang='less'>.card { col| }</style>", 'color'],
	['<style is:global>.card { col| }</style>', 'color'],
	['<style>.card { col|', 'color'],
	['<style>:root { --accent: red; } .card { color: var(--a|); }</style>', '--accent'],
	[
		'<style>:root { --accent: red; }</style>\n<style>.card { color: var(--a|); }</style>',
		'--accent',
	],
])('completes embedded styles: %s', async (source, label) => {
	const { server, params } = document(source);
	const result: any = await server.query('textDocument/completion', params);
	expect(result.items.map((item: any) => item.label)).toContain(label);
});

it('keeps CSS completion edits at their original UTF-16 and CRLF positions', async () => {
	const { server, params, text, offset } = document(
		'---\r\nconst title = "é😀";\r\n---\r\n<p>{title}</p>\r\n<style>.card { col| }</style>',
	);
	const result: any = await server.query('textDocument/completion', params);
	const item = result.items.find((item: any) => item.label === 'color');
	expect(item.textEdit.range).toEqual({
		start: position(text, offset - 3),
		end: position(text, offset),
	});
	expect(item.textEdit.newText).toMatch(/^color:/);
});

it('provides CSS property documentation', async () => {
	const { server, params } = document('<style>.card { co|lor: red; }</style>');
	const hover: any = await server.query('textDocument/hover', params);
	expect(hover.contents.value).toContain("color of an element's text");
});

it('navigates custom properties to definitions in another style block', async () => {
	const { server, params, text } = document(
		'<p>😀</p>\r\n<style>:root { --accent: red; }</style>\r\n<style>.card { color: var(--acc|ent); }</style>',
	);
	const result: any = await server.query('textDocument/definition', params);
	const offset = text.indexOf('--accent');
	expect(result).toEqual({
		uri,
		range: { start: position(text, offset), end: position(text, offset + '--accent'.length) },
	});
});

it('refreshes cached styles after edits without leaking variables between documents', async () => {
	const { server, params } = document(
		'<style>:root { --old: red; } .card { color: var(--|); }</style>',
	);
	const first: any = await server.query('textDocument/completion', params);
	expect(first.items.map((item: any) => item.label)).toContain('--old');
	const doc = server.documents.get(uri)!;
	doc.text = doc.text.replace('--old', '--new');
	doc.version++;
	const updated: any = await server.query('textDocument/completion', params);
	expect(updated.items.map((item: any) => item.label)).toContain('--new');
	expect(updated.items.map((item: any) => item.label)).not.toContain('--old');
	const otherUri = 'file:///other.xph';
	server.documents.set(otherUri, { text: '<style>.card { color: var(--); }</style>', version: 1 });
	const other: any = await server.query('textDocument/completion', {
		textDocument: { uri: otherUri },
		position: { line: 0, character: 27 },
	});
	expect(other.items.map((item: any) => item.label)).not.toContain('--new');
});
