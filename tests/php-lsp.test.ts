import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { position } from '../packages/xph/src/source.js';

it('bridges PHP queries, edits, definitions and diagnostics through stdio', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message), {
		entries: [],
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('editor.xph')).href;
	const text =
		'---\r\nexport interface Props { title: string }\r\n---\r\n<p>😀</p>\r\n<script server lang="php">\r\n$local = $props["title"];\r\nreturn [];\r\n</script>';
	server.documents.set(uri, { text, version: 1 });
	const params = { textDocument: { uri }, position: position(text, text.indexOf('$local') + 6) };
	try {
		const completion: any = await server.query('textDocument/completion', params);
		expect(completion.isIncomplete).toBe(true);
		expect(completion.items).toHaveLength(1);
		expect(completion.items[0].textEdit.range).toEqual({
			start: position(text, text.indexOf('$local')),
			end: params.position,
		});
		expect(completion.items[0].insertTextFormat).toBe(2);
		expect(await server.query('textDocument/hover', params)).toMatchObject({
			contents: { value: 'PHP hover' },
		});
		const definitions: any = await server.query('textDocument/definition', params);
		expect(definitions[0]).toEqual({ uri, range: completion.items[0].textEdit.range });
		expect(definitions[1].uri).toBe('file:///vendor/helper.php');
		const actions: any = await server.query('textDocument/codeAction', {
			textDocument: { uri },
			range: { start: position(text, text.indexOf('$local')), end: params.position },
			context: { only: ['quickfix'], diagnostics: [] },
		});
		expect(actions.map((action: any) => action.title)).toEqual(['Rename local', 'Resolve fix']);
		for (const action of actions) {
			expect(action.edit.documentChanges[0].textDocument).toEqual({ uri, version: 1 });
			expect(action.edit.documentChanges[0].edits).toEqual([
				{ range: completion.items[0].textEdit.range, newText: '$renamed' },
			]);
		}
		expect(
			await server.query('textDocument/codeAction', {
				textDocument: { uri },
				range: { start: { line: 0, character: 0 }, end: params.position },
				context: {},
			}),
		).toEqual([]);
		const fixAll: any = await server.query('textDocument/codeAction', {
			textDocument: { uri },
			range: { start: { line: 0, character: 0 }, end: position(text, text.length) },
			context: { only: ['source.fixAll'], diagnostics: [] },
		});
		expect(fixAll).toHaveLength(2);
		// Publish through the debounced document pipeline as well.
		server.schedule(uri);
		await new Promise((resolve) => setTimeout(resolve, 500));
		// A new version causes the backend to publish fresh diagnostics.
		await server.handle({
			method: 'textDocument/didChange',
			params: { textDocument: { uri, version: 2 }, contentChanges: [{ text }] },
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		const published = messages.filter((m) => m.method === 'textDocument/publishDiagnostics').at(-1);
		expect(
			published.params.diagnostics.some((d: any) => d.message === 'Mapped PHP diagnostic'),
		).toBe(true);
		expect(
			published.params.diagnostics.some((d: any) => d.message === 'Generated wrapper diagnostic'),
		).toBe(false);
		await server.handle({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
		expect(await server.query('textDocument/hover', params)).toBeNull();
	} finally {
		await server.handle({ id: 99, method: 'shutdown', params: {} });
	}
});

it('formats isolated PHP blocks while preserving markup and CRLF', async () => {
	const server = new LanguageServer(() => {}, {
		entries: [],
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('format.xph')).href;
	const text =
		'<p>😀 untouched</p>\r\n<script server lang="php">\r\n$local=1;\r\n</script>\r\n<script server lang="php">\r\n$local=2;\r\n</script>';
	server.documents.set(uri, { text, version: 1 });
	try {
		const edits: any = await server.query('textDocument/formatting', {
			textDocument: { uri },
			options: { tabSize: 4, insertSpaces: true },
		});
		expect(edits).toHaveLength(1);
		expect(edits[0].newText).toContain('<p>😀 untouched</p>');
		expect(edits[0].newText).toContain('\r\n$local = 1;\r\n');
		expect(edits[0].newText).toContain('\r\n$local = 2;\r\n');
		expect(edits[0].range).toEqual({
			start: { line: 0, character: 0 },
			end: position(text, text.length),
		});
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});
