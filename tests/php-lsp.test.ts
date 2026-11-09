import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { extractPHP, position } from '../packages/xph/src/source.js';

it('uses an editor-discovered PHP backend for formatting and diagnostics', async () => {
	const messages: any[] = [];
	const backend = { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] };
	const server = new LanguageServer((message) => messages.push(message));
	const uri = pathToFileURL(resolve('discovered.xph')).href;
	const text = '<script is:server>\n$local=1;\nreturn [];\n</script>';
	try {
		await server.handle({
			id: 1,
			method: 'initialize',
			params: {
				rootUri: pathToFileURL(process.cwd()).href,
				initializationOptions: { phpLanguageServerFallback: backend },
			},
		});
		expect(server.config.phpLanguageServer).toEqual(backend);
		await server.handle({
			method: 'textDocument/didOpen',
			params: {
				textDocument: { uri, text, version: 1 },
			},
		});
		const edits: any = await server.query('textDocument/formatting', {
			textDocument: { uri },
			options: { tabSize: 2, insertSpaces: true },
		});
		expect(edits[0].newText).toContain('$local = 1;');
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(
			messages.some(
				(message) =>
					message.method === 'textDocument/publishDiagnostics' &&
					message.params.diagnostics.some((d: any) => d.message === 'Mapped PHP diagnostic'),
			),
		).toBe(true);
	} finally {
		await server.handle({ id: 2, method: 'shutdown', params: {} });
	}
});

it('keeps the project PHP backend ahead of editor discovery', async () => {
	const backend = { command: 'project-php-server', args: ['--stdio'] };
	const server = new LanguageServer(() => {}, { phpLanguageServer: backend });
	await server.handle({
		id: 1,
		method: 'initialize',
		params: {
			initializationOptions: { phpLanguageServerFallback: { command: 'editor-php-server' } },
		},
	});
	expect(server.config.phpLanguageServer).toEqual(backend);
});

it('bridges PHP queries, edits, definitions and diagnostics through stdio', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message), {
		srcDir: 'src',
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('editor.xph')).href;
	const text =
		'---\r\nexport interface Props { title: string }\r\n---\r\n<p>😀</p>\r\n<script is:server>\r\n$local = $props["title"];\r\nreturn [];\r\n</script>';
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

it('formats the PHP server script while preserving markup and CRLF', async () => {
	const server = new LanguageServer(() => {}, {
		srcDir: 'src',
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('format.xph')).href;
	const text = '<p>😀 untouched</p>\r\n<script is:server>\r\n$local=1;\r\n$local=2;\r\n</script>';
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

it('delegates callback formatting to the PHP backend and preserves its indentation', async () => {
	const server = new LanguageServer(() => {}, {
		srcDir: 'src',
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('theme-format.xph')).href;
	const text = `<script is:server>
  add_action('after_setup_theme', static function () {
    add_theme_support('title-tag');
    register_nav_menus(['primary' => 'Primary navigation']);
  });
return [];
</script>`;
	server.documents.set(uri, { text, version: 1 });
	try {
		const params = { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } };
		const edits: any = await server.query('textDocument/formatting', params);
		expect(edits[0].newText).toBe(`<script is:server>
  add_action('after_setup_theme', static function () {
    add_theme_support('title-tag');
    register_nav_menus(['primary' => 'Primary navigation']);
  });
  return [];
</script>
`);
		server.documents.set(uri, { text: edits[0].newText, version: 2 });
		expect(await server.query('textDocument/formatting', params)).toEqual([]);
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});

it.each([
	['  ', '\n'],
	['    ', '\r\n'],
	['\t\t', '\r\n'],
])('retains the PHP embedding margin %j with %j line endings', async (margin, eol) => {
	const server = new LanguageServer(() => {}, {
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('embedded-format.xph')).href;
	const code = [
		'',
		margin + '$local=1;',
		margin + '$literal = "first',
		'  keep this whitespace',
		'last";',
		margin + "$doc = <<<'TEXT'",
		'keep this too',
		'TEXT;',
		margin + 'return [];',
		'  ',
	].join(eol);
	const text = '<section>' + eol + '  <script is:server>' + code + '</script>' + eol + '</section>';
	server.documents.set(uri, { text, version: 1 });
	try {
		const params = {
			textDocument: { uri },
			options: { tabSize: 2, insertSpaces: margin !== '\t\t' },
		};
		const edits: any = await server.query('textDocument/formatting', params);
		expect(extractPHP(edits[0].newText).blocks[0].code).toBe(
			code.replace('$local=1;', '$local = 1;'),
		);
		server.documents.set(uri, { text: edits[0].newText, version: 2 });
		expect(await server.query('textDocument/formatting', params)).toEqual([]);
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});

it('preserves inline PHP padding without duplicating it', async () => {
	const server = new LanguageServer(() => {}, {
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('inline-format.xph')).href;
	const text = '<script is:server>  $local=1; </script>';
	server.documents.set(uri, { text, version: 1 });
	try {
		const params = { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } };
		const edits: any = await server.query('textDocument/formatting', params);
		expect(edits[0].newText).toBe(text.replace('$local=1;', '$local = 1;') + '\n');
		server.documents.set(uri, { text: edits[0].newText, version: 2 });
		expect(await server.query('textDocument/formatting', params)).toEqual([]);
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});

it('keeps native and backend PHP diagnostics visible while newer checks are pending', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message), {
		php: '/missing/xph-test-php',
		phpLanguageServer: {
			command: process.execPath,
			args: [resolve('tests/fixtures/php-lsp.mjs'), '--delay-diagnostics'],
		},
	});
	const uri = pathToFileURL(resolve('stable-diagnostics.xph')).href;
	const text = '<script is:server>\n$local=1;\nreturn [];\n</script>';
	const published = (version: number) =>
		messages.filter(
			(message) =>
				message.method === 'textDocument/publishDiagnostics' && message.params.version === version,
		);
	const backendError = (message: any) =>
		message.params.diagnostics.find((d: any) => d.message === 'Mapped PHP diagnostic');
	try {
		await server.handle({
			method: 'textDocument/didOpen',
			params: { textDocument: { uri, text, version: 1 } },
		});
		await expect.poll(() => published(1).some(backendError)).toBe(true);
		// Shift the PHP range while keeping the error itself unchanged.
		await server.handle({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version: 2 },
				contentChanges: [{ text: '\n' + text }],
			},
		});
		await expect.poll(() => published(2).length).toBeGreaterThanOrEqual(2);
		for (const message of published(2)) {
			expect(backendError(message)).toMatchObject({
				range: {
					start: { line: 2, character: 0 },
					end: { line: 2, character: 6 },
				},
			});
			expect(
				message.params.diagnostics.some((d: any) => d.message.includes('/missing/xph-test-php')),
			).toBe(true);
		}
		// A genuine empty response must still clear a resolved backend error.
		await server.handle({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version: 3 },
				contentChanges: [{ text: text.replace('$local', '$fixed') }],
			},
		});
		await expect.poll(() => published(3).length).toBeGreaterThanOrEqual(2);
		expect(backendError(published(3).at(-1))).toBeUndefined();
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});
