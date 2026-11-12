import { execFileSync } from 'node:child_process';
import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatAstro } from '../packages/language-server/src/format.js';
import { extractPHP } from '../packages/xph/src/source.js';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { PHPClient } from '../packages/language-server/src/php.js';
import { pathToFileURL } from 'node:url';
const options = { tabSize: 2, insertSpaces: true };

it.each([
	'<div><svg viewBox="0 0 1440 126">\n</div>',
	'---\nconst =\n---\n<p />',
	'<script>const =</script>',
	'<script is:server>return [];',
])('skips invalid source without RPC errors and formats again after a fix: %s', async (text) => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message));
	const uri = pathToFileURL(resolve('Incomplete.xph')).href;
	const doc = { text, version: 1 };
	server.documents.set(uri, doc);
	for (const id of [1, 2]) {
		await server.handle({
			id,
			method: 'textDocument/formatting',
			params: { textDocument: { uri }, options },
		});
		expect(messages.find((message) => message.id === id)).toEqual({
			jsonrpc: '2.0',
			id,
			result: [],
		});
		expect(doc.text).toBe(text);
	}
	doc.text = '<div><svg viewBox="0 0 1440 126"></svg></div>';
	doc.version++;
	await server.handle({
		id: 3,
		method: 'textDocument/formatting',
		params: { textDocument: { uri }, options },
	});
	expect(messages.find((message) => message.id === 3).result[0].newText).toContain('</svg>');
	expect(messages.some((message) => message.error || message.params?.type === 1)).toBe(false);
});

it('does not emit partial PHP edits when markup cannot be formatted', async () => {
	const server = new LanguageServer(() => {}, {
		phpLanguageServer: { command: process.execPath, args: [resolve('tests/fixtures/php-lsp.mjs')] },
	});
	const uri = pathToFileURL(resolve('IncompletePHP.xph')).href;
	const text = '<script is:server>$local=1;return [];</script>\n<div><svg></div>';
	server.documents.set(uri, { text, version: 1 });
	try {
		expect(
			await server.query('textDocument/formatting', { textDocument: { uri }, options }),
		).toEqual([]);
		expect(server.documents.get(uri)?.text).toBe(text);
	} finally {
		await server.handle({ id: 1, method: 'shutdown', params: {} });
	}
});

it('keeps malformed formatter configuration visible as an RPC error', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-bad-format-config-'));
	try {
		await mkdir(join(root, 'node_modules'));
		for (const name of ['prettier', 'prettier-plugin-astro'])
			await symlink(resolve('node_modules', name), join(root, 'node_modules', name), 'dir');
		await writeFile(join(root, '.prettierrc.json'), '{ invalid JSON');
		const messages: any[] = [];
		const server = new LanguageServer((message) => messages.push(message));
		const uri = pathToFileURL(join(root, 'Config.xph')).href;
		server.documents.set(uri, { text: '<p>valid</p>', version: 1 });
		await server.handle({
			id: 1,
			method: 'textDocument/formatting',
			params: { textDocument: { uri }, options },
		});
		expect(messages.find((message) => message.id === 1).error.code).toBe(-32603);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each([false, true])(
	'defers diagnostics during formatting and resumes after failure=%s',
	async (fail) => {
		vi.useFakeTimers();
		const server = new LanguageServer(() => {}, { phpLanguageServer: { command: 'unused' } });
		const uri = pathToFileURL(resolve('Save.xph')).href;
		const text = '<script is:server>return [];</script>';
		server.documents.set(uri, { text, version: 1 });
		let finish!: (edits: []) => void;
		let reject!: (error: Error) => void;
		vi.spyOn(PHPClient.prototype, 'format').mockImplementation(
			() =>
				new Promise((resolve, onError) => {
					finish = resolve;
					reject = onError;
				}),
		);
		const analyze = vi
			.spyOn(server as any, 'backgroundDiagnostics')
			.mockRejectedValue(new Error('diagnostics resumed'));
		try {
			server.schedule(uri);
			const formatting = server.query('textDocument/formatting', {
				textDocument: { uri },
				options,
			});
			const result = fail ? expect(formatting).rejects.toThrow('backend failed') : formatting;
			await vi.advanceTimersByTimeAsync(300);
			expect(analyze).not.toHaveBeenCalled();
			if (fail) reject(new Error('backend failed'));
			else finish([]);
			await result;
			await vi.advanceTimersByTimeAsync(150);
			expect(analyze).toHaveBeenCalledOnce();
		} finally {
			await server.handle({ id: 99, method: 'shutdown', params: {} });
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	},
);

it('formats Astro frontmatter, markup, browser scripts and styles while protecting PHP', async () => {
	const source = `---
export interface Props{title:string}
const title="hello"
---
<script is:server>
$message = "</script>";
return ['title'=>$message];
</script>
<section><h1>{title}</h1><p class="hint">hello</p></section>
<script>const answer={value:42};console.log(answer)</script>
<style>.hint{color:red;padding:0 1px}</style>`;
	const result = await formatAstro(source, resolve('Format.xph'), options);
	expect(result).toContain('title: string');
	expect(result).toContain('const title = "hello";');
	expect(result).toContain('const answer = { value: 42 };');
	expect(result).toContain('color: red;');
	expect(extractPHP(result).blocks[0].code).toBe(extractPHP(source).blocks[0].code);
	expect(await formatAstro(result, resolve('Format.xph'), options)).toBe(result);
});

it('honors project Prettier settings and formats without a PHP backend', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-format-'));
	try {
		await mkdir(join(root, 'node_modules'));
		for (const name of ['prettier', 'prettier-plugin-astro'])
			await symlink(resolve('node_modules', name), join(root, 'node_modules', name), 'dir');
		await writeFile(
			join(root, '.prettierrc.json'),
			JSON.stringify({ singleQuote: true, semi: false, plugins: ['prettier-plugin-astro'] }),
		);
		const filename = join(root, 'Page.xph');
		const uri = pathToFileURL(filename).href;
		const server = new LanguageServer(() => {});
		const source =
			'---\nconst title="hello";\n---\n<h1>{title}</h1>\n<script is:server>return [];</script>';
		server.documents.set(uri, { text: source, version: 1 });
		const edits: any = await server.query('textDocument/formatting', {
			textDocument: { uri },
			options,
		});
		expect(edits[0].newText).toContain("const title = 'hello'\n");
		expect(edits[0].newText).toContain('<script is:server>return [];</script>');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves source and reports missing optional formatter dependencies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-no-formatter-'));
	try {
		const source = '<div>   unformatted   </div>';
		const result = runFormatter(join(root, 'Page.xph'), source);
		expect(result.text).toBe(source);
		expect(result.messages[0]).toContain('project dependencies');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function runFormatter(filename: string, source: string) {
	const module = pathToFileURL(resolve('packages/language-server/dist/format.js')).href;
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
		import { formatAstro } from ${JSON.stringify(module)};
		const messages = [];
		const text = await formatAstro(${JSON.stringify(source)}, ${JSON.stringify(filename)}, { tabSize: 2, insertSpaces: true }, message => messages.push(message));
		console.log(JSON.stringify({ text, messages }));
	`,
			],
			{ encoding: 'utf8' },
		),
	);
}

it('loads the project-owned Prettier and Astro plugin instead of server dependencies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-local-formatter-'));
	try {
		for (const name of ['prettier', 'prettier-plugin-astro']) {
			const directory = join(root, 'node_modules', name);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, 'package.json'),
				JSON.stringify({ name, type: 'module', main: 'index.js' }),
			);
			await writeFile(
				join(directory, 'index.js'),
				name === 'prettier'
					? `
				export const version = '3.0.0';
				export const resolveConfig = async () => ({});
				export const resolveConfigFile = async () => null;
				export const format = async (text, options) => {
					if (!options.plugins[0].defaultOptions.projectPlugin) throw new Error('Wrong Astro plugin');
					return text + '<!--project formatter and plugin-->';
				};
			`
					: `export const parsers = {}, printers = {}, options = {}, defaultOptions = { projectPlugin: true };`,
			);
		}
		expect(runFormatter(join(root, 'Page.xph'), '<p>test</p>').text).toBe(
			'<p>test</p><!--project formatter and plugin-->',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves nested PHP blocks and multiline literals exactly', async () => {
	const source = `<section>
<script is:server>
return [
  'heading' => strtoupper(
    $props['title']
  ),
  'literal' => "first
unchanged
last",
  'doc' => <<<'TEXT'
keep this
TEXT,
];
</script>
</section>`;
	const result = await formatAstro(source, resolve('Indent.xph'), options);
	expect(result).toContain('  <script is:server>');
	const block = extractPHP(source).blocks[0];
	expect(result).toContain(source.slice(block.start, block.end));
	expect(extractPHP(result).blocks[0].code).toBe(block.code);
	expect(await formatAstro(result, resolve('Indent.xph'), options)).toBe(result);
});

it('preserves PHP whitespace and CRLF regardless of indentation settings', async () => {
	const source = '<script is:server>\r\nreturn [\r\n\t1,\r\n];\r\n</script>';
	const result = await formatAstro(source, resolve('Tabs.xph'), {
		tabSize: 4,
		insertSpaces: false,
	});
	expect(result).toContain(source);
	expect(await formatAstro(result, resolve('Tabs.xph'), { tabSize: 4, insertSpaces: false })).toBe(
		result,
	);
});

it('preserves inconsistent PHP indentation without a PHP backend', async () => {
	const source = `<script is:server>
  add_action('after_setup_theme', static function () {
    add_theme_support('title-tag');
    register_nav_menus(['primary' => 'Primary navigation']);
  });
return [];
</script>`;
	const uri = pathToFileURL(resolve('Theme.xph')).href;
	const server = new LanguageServer(() => {});
	server.documents.set(uri, { text: source, version: 1 });
	const edits: any = await server.query('textDocument/formatting', {
		textDocument: { uri },
		options,
	});
	expect(edits[0].newText).toBe(source + '\n');
	const result = await formatAstro(source, resolve('Theme.xph'), options);
	expect(result).toBe(source + '\n');
	expect(await formatAstro(result, resolve('Theme.xph'), options)).toBe(result);
});
