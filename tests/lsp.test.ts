import { describe, it, expect } from 'vitest';
import { position } from '../packages/xph/src/source.js';
import { LanguageServer, start } from '../packages/language-server/src/index.js';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const uri = pathToFileURL(join(process.cwd(), 'editor.xph')).href;
const waitFor = async (test: () => boolean) => {
	for (let i = 0; i < 100; i++) {
		if (test()) return;
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error('Timed out');
};
describe('language server', () => {
	it('initializes over framed JSON-RPC, including split UTF8 input', async () => {
		const input = new PassThrough(),
			output = new PassThrough();
		let response = '';
		output.on('data', (c) => (response += c));
		start(input, output);
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { initializationOptions: { entries: [] } },
		});
		const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		input.write(frame.subarray(0, 19));
		input.write(frame.subarray(19));
		await waitFor(() => response.includes('capabilities'));
		expect(response).toContain('completionProvider');
		input.end();
	});
	it('offers contract completions and hover in unsaved templates', async () => {
		const messages: any[] = [],
			server = new LanguageServer((m) => messages.push(m));
		const text =
			'---\nexport interface Props { title: string; count: number }\n---\n<p>{props.title}</p>';
		server.documents.set(uri, { text, version: 1 });
		const completions: any = await server.query('textDocument/completion', {
			textDocument: { uri },
			position: { line: 3, character: 10 },
		});
		expect(completions.items.some((i: any) => i.label === 'title')).toBe(true);
		const hover: any = await server.query('textDocument/hover', {
			textDocument: { uri },
			position: { line: 3, character: 12 },
		});
		expect(hover.contents.value).toContain('string');
	});
	it('publishes only the current version after rapid unsaved edits', async () => {
		const messages: any[] = [],
			server = new LanguageServer((m) => messages.push(m));
		await server.handle({
			method: 'textDocument/didOpen',
			params: { textDocument: { uri, version: 1, text: '<p>{missing}</p>' } },
		});
		await server.handle({
			method: 'textDocument/didChange',
			params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '<p>é😀 fixed</p>' }] },
		});
		await waitFor(() => messages.some((m) => m.method === 'textDocument/publishDiagnostics'));
		expect(
			messages
				.filter((m) => m.method === 'textDocument/publishDiagnostics')
				.every((m) => m.params.version === 2),
		).toBe(true);
		expect(messages[0].params.diagnostics).toEqual([]);
		await server.handle({ method: 'shutdown', id: 9 });
	});
	it('follows component definitions and reacts to dependency edits', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-lsp-'));
		const messages: any[] = [],
			server = new LanguageServer((m) => messages.push(m));
		try {
			const child = join(root, 'Child.xph'),
				parent = join(root, 'Parent.xph'),
				parentUri = pathToFileURL(parent).href,
				childUri = pathToFileURL(child).href;
			await writeFile(child, '---\nexport interface Props { title:string }\n---\n{props.title}');
			const text = '---\nimport Child from "./Child.xph";\n---\n<Child title="hi"/>';
			server.documents.set(parentUri, { text, version: 1 });
			expect(
				await server.query('textDocument/definition', {
					textDocument: { uri: parentUri },
					position: { line: 3, character: 3 },
				}),
			).toMatchObject({ uri: childUri });
			await server.handle({
				method: 'textDocument/didOpen',
				params: {
					textDocument: {
						uri: childUri,
						version: 1,
						text: '---\nexport interface Props { title:number }\n---\n{props.title}',
					},
				},
			});
			await server.handle({
				method: 'textDocument/didChange',
				params: {
					textDocument: { uri: childUri, version: 2 },
					contentChanges: [
						{ text: '---\nexport interface Props { title:boolean }\n---\n{props.title}' },
					],
				},
			});
			await waitFor(() =>
				messages.some(
					(m) =>
						m.params?.uri === parentUri &&
						m.params.diagnostics.some((d: any) => d.source === 'typescript'),
				),
			);
			await server.handle({ method: 'shutdown', id: 5 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('loads an explicit project config when the CLI starts outside the project', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-lsp-config-'));
		const config = join(root, 'xph.config.ts');
		await writeFile(
			config,
			`export default { entries: [], phpLanguageServer: { command: 'xph-test-missing-php-backend' } };`,
		);
		const child = spawn(process.execPath, ['packages/xph/dist/cli.js', 'lsp', config], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		const send = (message: unknown) => {
			const body = JSON.stringify(message);
			child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		};
		try {
			send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
			await waitFor(() => stdout.includes('capabilities'));
			send({
				jsonrpc: '2.0',
				method: 'textDocument/didOpen',
				params: {
					textDocument: {
						uri: pathToFileURL(join(root, 'Page.xph')).href,
						version: 1,
						text: '<script server lang="php">return [];</script>',
					},
				},
			});
			await waitFor(() => stdout.includes('xph-test-missing-php-backend'));
			expect(stdout).toContain('window/logMessage');
		} finally {
			child.kill();
			await rm(root, { recursive: true, force: true });
		}
	});
	it('starts through the installed CLI lsp command', async () => {
		const child = spawn(process.execPath, ['packages/xph/dist/cli.js', 'lsp'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		child.stdout.on('data', (c) => (stdout += c));
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		try {
			await waitFor(() => stdout.includes('capabilities'));
		} finally {
			child.kill();
		}
	});
});

describe('Go to Definition', () => {
	const definition = async (
		server: LanguageServer,
		text: string,
		offset: number,
		documentUri = uri,
	) => {
		server.documents.set(documentUri, { text, version: 1 });
		return server.query('textDocument/definition', {
			textDocument: { uri: documentUri },
			position: position(text, offset),
		});
	};
	it('maps contract properties and constants back to exact source ranges', async () => {
		const server = new LanguageServer(() => {});
		const text =
			'---\r\nexport interface Props { title: string }\r\nexport interface Server { heading: string }\r\nconst label = "é😀";\r\n---\r\n<p>é😀{props.title}{server.heading}{label}</p>';
		for (const name of ['title', 'heading', 'label']) {
			const result = await definition(server, text, text.lastIndexOf(name) + 2);
			const start = text.indexOf(name);
			expect(result).toEqual([
				{ uri, range: { start: position(text, start), end: position(text, start + name.length) } },
			]);
		}
	});
	it('finds local loop parameters and frontmatter references', async () => {
		const server = new LanguageServer(() => {});
		const text =
			'---\nconst first = "hi";\nconst second = first;\n---\n{[second].map(item => <p>{item}</p>)}';
		for (const name of ['first', 'item']) {
			const result = await definition(server, text, text.lastIndexOf(name) + 1);
			const start = text.indexOf(name);
			expect(result).toEqual([
				{ uri, range: { start: position(text, start), end: position(text, start + name.length) } },
			]);
		}
	});
	it('resolves component imports, opening and closing tags without matching prefixes or comments', async () => {
		const server = new LanguageServer(() => {});
		const childUri = pathToFileURL(join(process.cwd(), 'Child.xph')).href;
		server.documents.set(childUri, { text: '<slot/>', version: 1 });
		const text =
			'---\nimport Child from "./Child.xph";\n---\n<Child><p>Hi</p></Child>\n<ChildExtra/>\n<!-- <Child/> -->\n<p title="<Child>">text</p>';
		for (const offset of [
			text.indexOf('Child') + 2,
			text.indexOf('./Child') + 3,
			text.indexOf('<Child>') + 3,
			text.indexOf('</Child>') + 4,
		])
			expect(await definition(server, text, offset)).toMatchObject({ uri: childUri });
		for (const offset of [
			text.indexOf('<ChildExtra') + 3,
			text.indexOf('<!-- <Child') + 8,
			text.lastIndexOf('<Child>') + 3,
		])
			expect(await definition(server, text, offset)).toBeNull();
	});
	it('follows TypeScript imports and honors unsaved dependency contents', async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-definitions-'));
		try {
			const server = new LanguageServer(() => {});
			const target = join(root, 'values.ts');
			await writeFile(target, 'export const title = "saved";');
			const targetUri = pathToFileURL(target).href;
			const unsaved = '\n\nexport const title = "unsaved";';
			server.documents.set(targetUri, { text: unsaved, version: 2 });
			const text = '---\nimport { title } from "./values";\n---\n<p>{title}</p>';
			const result = await definition(
				server,
				text,
				text.lastIndexOf('title') + 2,
				pathToFileURL(join(root, 'Page.xph')).href,
			);
			const start = unsaved.indexOf('title');
			expect(result).toEqual([
				{
					uri: targetUri,
					range: { start: position(unsaved, start), end: position(unsaved, start + 5) },
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it.each([
	['server.count.', []],
	['server.name.', []],
	['server.enabled.', []],
	['server.items.', ['length', 'map']],
	['server.optional?.', ['length', 'map']],
	['server.record.', ['title', 'length']],
	['props.items.', ['length', 'map']],
	['server.items.map((item) => <p>{item.', []],
])('limits template member completions for %s', async (expression, expected) => {
	const server = new LanguageServer(() => {});
	const prefix =
		'---\nexport interface Server { count: number; name: string; enabled: boolean; items: string[]; optional?: number[]; record: { title: string; length: number } }\nexport interface Props { items: number[] }\n---\n';
	const suffix = expression.includes('=>') ? '}</p>)}' : '}';
	const text = prefix + '{' + expression + suffix;
	server.documents.set(uri, { text, version: 1 });
	const completions: any = await server.query('textDocument/completion', {
		textDocument: { uri },
		position: { line: 4, character: 1 + expression.length },
	});
	expect(completions).not.toBeNull();
	expect(completions.items.map((item: any) => item.label).sort()).toEqual([...expected].sort());
});

it('keeps JavaScript methods available in build-time frontmatter', async () => {
	const server = new LanguageServer(() => {});
	const text =
		'---\nconst number = 1;\nconst formatted = number.toFixed(2);\n---\n<p>{formatted}</p>';
	server.documents.set(uri, { text, version: 1 });
	const completions: any = await server.query('textDocument/completion', {
		textDocument: { uri },
		position: { line: 2, character: 25 },
	});
	expect(completions.items.some((item: any) => item.label === 'toFixed')).toBe(true);
});

it('completes and hovers declared Server methods', async () => {
	const server = new LanguageServer(() => {});
	const text =
		'---\nexport interface Server { upper(value: string): string; count: (items: string[]) => number }\n---\n{server.upper("hello")}';
	server.documents.set(uri, { text, version: 1 });
	const completions: any = await server.query('textDocument/completion', {
		textDocument: { uri },
		position: { line: 3, character: 8 },
	});
	expect(completions.items.map((item: any) => item.label).sort()).toEqual(['count', 'upper']);
	const hover: any = await server.query('textDocument/hover', {
		textDocument: { uri },
		position: { line: 3, character: 10 },
	});
	expect(hover.contents.value).toContain('upper(value: string): string');
});
