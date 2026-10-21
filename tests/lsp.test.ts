import { describe, it, expect } from 'vitest';
import { position } from '../packages/xph/src/source.js';
import { LanguageServer, start } from '../packages/language-server/src/index.js';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
						text: '<script is:server>return [];</script>',
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
	it('navigates native HTML attributes to their declarations', async () => {
		const server = new LanguageServer(() => {});
		for (const [text, name] of [
			['<meta charset="utf-8" />', 'charset'],
			['<a href="/">Link</a>', 'href'],
			['<p class="text" id="intro">Text</p>', 'class'],
			['<p class="text" id="intro">Text</p>', 'id'],
			['<input disabled />', 'disabled'],
			['<meta http-equiv="refresh" />', 'http-equiv'],
		]) {
			const result = await definition(server, text, text.indexOf(name) + 2);
			expect(result).toHaveLength(1);
			expect(result[0].uri).toMatch(/\/xph\.d\.ts$/);
			const source = await readFile(new URL(result[0].uri), 'utf8');
			const { start, end } = result[0].range;
			expect(start.line).toBe(end.line);
			expect(source.split('\n')[start.line].slice(start.character, end.character)).toBe(name);
		}
	});
	it('resolves native opening, closing and self-closing tags to xph declarations', async () => {
		const server = new LanguageServer(() => {});
		const text = '<div><a href="/">Link</a><p>Text</p><input /><svg><circle /></svg></div>';
		for (const tag of ['div', 'a', 'p', 'input', 'svg', 'circle']) {
			for (const marker of [`<${tag}`, `</${tag}`]) {
				const start = text.indexOf(marker);
				if (start < 0) continue;
				const result = await definition(server, text, start + marker.length);
				expect(result.uri).toMatch(/\/xph\.d\.ts$/);
				const source = await readFile(new URL(result.uri), 'utf8');
				const { start: targetStart, end: targetEnd } = result.range;
				expect(targetStart.line).toBe(targetEnd.line);
				expect(
					source.split('\n')[targetStart.line].slice(targetStart.character, targetEnd.character),
				).toBe(tag);
			}
		}
		for (const [text, offset] of [
			['<unknown-tag />', 3],
			['<math><mi>x</mi></math>', 3],
			['<math><mi>x</mi></math>', 8],
			['<!-- <div /> -->', 7],
			['<p title="<div>">Text</p>', 12],
		] as const) {
			expect(await definition(server, text, offset)).toBeNull();
		}
		const svg = '<svg><a /></svg>';
		const target = await definition(server, svg, svg.indexOf('<a') + 2);
		const declarations = await readFile(new URL(target.uri), 'utf8');
		expect(target.range.start).toEqual(
			position(
				declarations,
				declarations.indexOf('a:', declarations.indexOf('interface SVGElements')),
			),
		);
	});
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
		]) {
			const result = await definition(server, text, offset);
			expect(
				Array.isArray(result) ? result : [result],
				`definition at offset ${offset}`,
			).toMatchObject([{ uri: childUri }]);
		}
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

it('completes imported mapped contract fields with synthetic properties', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-mapped-completions-'));
	try {
		await writeFile(
			join(root, 'fields.ts'),
			`
export const fields = [{ name: 'title', type: 'text' }, { name: 'count', type: 'number' }] as const;
export type Values<T extends readonly { name: string; type: string }[]> = {
 [F in T[number] as F['name']]: F['type'] extends 'text' ? string : number;
};`,
		);
		const documentUri = pathToFileURL(join(root, 'Mapped.xph')).href;
		const text = `---
import { fields, type Values } from './fields';
export interface Server { fields: Values<typeof fields> }
---
<script is:server>return ['fields' => ['title' => '', 'count' => 0]];</script>
<p>{server.fields.}</p>`;
		const server = new LanguageServer(() => {});
		server.documents.set(documentUri, { text, version: 1 });
		const completions: any = await server.query('textDocument/completion', {
			textDocument: { uri: documentUri },
			position: position(text, text.indexOf('server.fields.') + 'server.fields.'.length),
		});
		expect(completions.items.map((item: any) => item.label).sort()).toEqual(['count', 'title']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('completes native attributes in markup and JSX expressions', async () => {
	const server = new LanguageServer(() => {});
	for (const text of ['<input  />', '{true && <input  />}', '<input ', '<input pla']) {
		server.documents.set(uri, { text, version: 1 });
		const result: any = await server.query('textDocument/completion', {
			textDocument: { uri },
			position: position(text, text.includes('  ') ? text.indexOf('  ') + 1 : text.length),
		});
		expect(result).not.toBeNull();
		const labels = result.items.map((item: any) => item.label);
		for (const name of ['class', 'id', 'type', 'placeholder', 'disabled', 'aria-label'])
			expect(labels).toContain(name);
		expect(labels).not.toContain('onClick');
	}
});
it('completes imported component props and hovers attributes at their original positions', async () => {
	const server = new LanguageServer(() => {});
	const childUri = pathToFileURL(join(process.cwd(), 'Card.xph')).href;
	server.documents.set(childUri, {
		text: '---\nexport interface Props { title: string; count?: number; active?: boolean }\n---\n<slot/>',
		version: 1,
	});
	for (const tag of [
		'<Card  />',
		'<Card active\n title="é😀"\n  />',
		'{true && <Card  />}',
		'<Card ',
		'<Card co',
	]) {
		const text = `---\nimport Card from './Card.xph';\n---\n${tag}`;
		server.documents.set(uri, { text, version: 1 });
		const result: any = await server.query('textDocument/completion', {
			textDocument: { uri },
			position: position(text, text.includes('  ') ? text.lastIndexOf('  ') + 1 : text.length),
		});
		expect(result).not.toBeNull();
		expect(result.items.map((item: any) => item.label)).toContain('count');
	}
	const text = '---\nimport Card from "./Card.xph";\n---\n<Card active\n  title="é😀" count={3} />';
	server.documents.set(uri, { text, version: 1 });
	const hover: any = await server.query('textDocument/hover', {
		textDocument: { uri },
		position: position(text, text.indexOf('count=') + 2),
	});
	expect(hover.contents.value).toContain('"count"?: number');
});

it('offers native attribute values and documentation without intercepting expressions', async () => {
	const server = new LanguageServer(() => {});
	const text = '<input type="" class="" />';
	server.documents.set(uri, { text, version: 1 });
	const values: any = await server.query('textDocument/completion', {
		textDocument: { uri },
		position: position(text, text.indexOf('"') + 1),
	});
	expect(values.items.map((item: any) => item.label)).toContain('email');
	const hover: any = await server.query('textDocument/hover', {
		textDocument: { uri },
		position: position(text, text.indexOf('class') + 1),
	});
	expect(hover.contents.value).toContain('classes');
	const expression = '---\nexport interface Props { label: string }\n---\n<input value={props.} />';
	server.documents.set(uri, { text: expression, version: 2 });
	const fields: any = await server.query('textDocument/completion', {
		textDocument: { uri },
		position: position(expression, expression.indexOf('props.') + 6),
	});
	expect(fields.items.map((item: any) => item.label)).toEqual(['label']);
});

it('navigates component JSX prop names to their declarations in unsaved components', async () => {
	const server = new LanguageServer(() => {});
	const childUri = pathToFileURL(join(process.cwd(), 'Card.xph')).href;
	const child =
		'---\r\nconst label = "é😀";\r\ninterface Base { title: string }\r\nexport interface Props extends Base { active?: boolean }\r\n---\r\n<slot/>';
	server.documents.set(childUri, { text: child, version: 1 });
	for (const markup of [
		'<Card title="hello" active />',
		'{["one"].map(item => <Card title={item} active />)}',
	]) {
		const text = `---\nimport Card from './Card.xph';\n---\n${markup}`;
		server.documents.set(uri, { text, version: 1 });
		for (const name of ['title', 'active']) {
			const result = await server.query('textDocument/definition', {
				textDocument: { uri },
				position: position(text, text.lastIndexOf(name) + 2),
			});
			const start = child.indexOf(name);
			expect(result).toEqual([
				{
					uri: childUri,
					range: { start: position(child, start), end: position(child, start + name.length) },
				},
			]);
		}
	}
});
it('navigates inherited component props to unsaved TypeScript type declarations', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-prop-definitions-'));
	try {
		const base = 'export interface Base<T> { title: T }';
		await writeFile(join(root, 'base.ts'), base);
		const childUri = pathToFileURL(join(root, 'Card.xph')).href;
		const baseUri = pathToFileURL(join(root, 'base.ts')).href;
		const parentUri = pathToFileURL(join(root, 'Page.xph')).href;
		const child =
			'---\nimport type { Base } from "./base";\nexport type Props = Base<string>;\n---\n<slot/>';
		const unsaved = '// é😀\n\n' + base;
		const text = '---\nimport Card from "./Card.xph";\n---\n<Card title="hello"/>';
		const server = new LanguageServer(() => {});
		server.documents.set(childUri, { text: child, version: 1 });
		server.documents.set(baseUri, { text: unsaved, version: 2 });
		server.documents.set(parentUri, { text, version: 1 });
		const result = await server.query('textDocument/definition', {
			textDocument: { uri: parentUri },
			position: position(text, text.lastIndexOf('title') + 2),
		});
		const start = unsaved.indexOf('title');
		expect(result).toEqual([
			{
				uri: baseUri,
				range: { start: position(unsaved, start), end: position(unsaved, start + 5) },
			},
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('publishes unknown native attributes and component props as editor errors', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message));
	const childUri = pathToFileURL(join(process.cwd(), 'Card.xph')).href;
	server.documents.set(childUri, {
		text: '---\nexport interface Props { title: string }\n---\n<slot/>',
		version: 1,
	});
	const text =
		'---\nimport Card from "./Card.xph";\n---\n<h2 tile="sss">heading</h2>{true && <h2 tile="jsx"/>}<Card title="ok" tile="wrong"/>';
	await server.handle({
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, text, version: 1 } },
	});
	await waitFor(() =>
		messages.some((message) => message.method === 'textDocument/publishDiagnostics'),
	);
	const diagnostics = messages.find(
		(message) => message.method === 'textDocument/publishDiagnostics',
	).params.diagnostics;
	const native = diagnostics.filter(
		(diagnostic: any) =>
			diagnostic.source === 'typescript' &&
			diagnostic.message.includes('tile') &&
			diagnostic.range.start.character < position(text, text.indexOf('<Card title')).character,
	);
	expect(native).toHaveLength(2);
	for (const diagnostic of native) {
		expect(diagnostic.severity).toBe(1);
		expect(diagnostic.message).toContain("'tile'");
	}
	expect(native[0].range).toEqual({
		start: position(text, text.indexOf('tile')),
		end: position(text, text.indexOf('tile') + 4),
	});
	expect(
		diagnostics.some(
			(diagnostic: any) =>
				diagnostic.source === 'typescript' && diagnostic.message.includes('tile'),
		),
	).toBe(true);
});
it('accepts native attributes, directives, data attributes and custom elements in editor diagnostics', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message));
	const text =
		'<h2 title="sss" data-tile="ok" aria-label="heading" class:list={["title"]}/><my-heading tile="custom"/>';
	await server.handle({
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, text, version: 1 } },
	});
	await waitFor(() =>
		messages.some((message) => message.method === 'textDocument/publishDiagnostics'),
	);
	expect(
		messages.find((message) => message.method === 'textDocument/publishDiagnostics').params
			.diagnostics,
	).toEqual([]);
});

it('reports TypeScript errors for native attribute values in markup and scoped JSX', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message));
	const text =
		'---\nconst values = [1, 2];\n---\n<p title={2}/><input type="invalid-type"/><button disabled={1}/>{values.map(value => <p title={value}/>)}';
	await server.handle({
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, text, version: 1 } },
	});
	await waitFor(() =>
		messages.some((message) => message.method === 'textDocument/publishDiagnostics'),
	);
	const diagnostics = messages.find(
		(message) => message.method === 'textDocument/publishDiagnostics',
	).params.diagnostics;
	expect(diagnostics).toHaveLength(4);
	for (const [index, name] of ['title', 'type', 'disabled', 'title'].entries()) {
		const offset = index === 3 ? text.lastIndexOf('title') : text.indexOf(name);
		expect(diagnostics[index]).toMatchObject({
			source: 'typescript',
			severity: 1,
			range: { start: position(text, offset), end: position(text, offset + name.length) },
		});
		expect(diagnostics[index].message).toContain('not assignable');
	}
});

it('accepts typed native values, spreads and lexical scopes without duplicate diagnostics', async () => {
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message));
	const text =
		'---\nconst title = "Hello";\nconst attributes = { title };\nconst values = ["one", "two"];\n---\n<p title={title}/><p {...attributes}/><input type="email" disabled/><textarea rows={3}/>{values.map(value => <p title={value}/>)}';
	await server.handle({
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, text, version: 1 } },
	});
	await waitFor(() =>
		messages.some((message) => message.method === 'textDocument/publishDiagnostics'),
	);
	expect(
		messages.find((message) => message.method === 'textDocument/publishDiagnostics').params
			.diagnostics,
	).toEqual([]);
});

it.each([
	['---\nconst attributes = { title: 2 };\n---\n<p {...attributes}/>', 'not assignable'],
	['<p title/>', 'not assignable'],
	['<p title={missing}/>', "Cannot find name 'missing'"],
])(
	'checks native attributes without duplicating existing TypeScript errors: %s',
	async (text, message) => {
		const messages: any[] = [];
		const server = new LanguageServer((message) => messages.push(message));
		await server.handle({
			method: 'textDocument/didOpen',
			params: { textDocument: { uri, text, version: 1 } },
		});
		await waitFor(() =>
			messages.some((message) => message.method === 'textDocument/publishDiagnostics'),
		);
		const diagnostics = messages
			.find((message) => message.method === 'textDocument/publishDiagnostics')
			.params.diagnostics.filter((item: any) => item.source === 'typescript');
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain(message);
	},
);

it('offers xph member completions and resolves xph.self to the current component', async () => {
	const server = new LanguageServer(() => {});
	for (const [text, member] of [
		['<p>{xph.}</p>', 'slots'],
		['<p>{xph.slots.}</p>', 'render'],
		['<xph. />', 'self'],
	]) {
		server.documents.set(uri, { text, version: 1 });
		const offset = text.lastIndexOf('.') + 1;
		const completion: any = await server.query('textDocument/completion', {
			textDocument: { uri },
			position: position(text, offset),
		});
		expect(completion.items.some((item: any) => item.label === member)).toBe(true);
	}
	const text =
		'---\nexport interface Props { depth: number }\n---\n{props.depth > 0 && <xph.self depth={props.depth - 1} />}';
	server.documents.set(uri, { text, version: 2 });
	const definition = await server.query('textDocument/definition', {
		textDocument: { uri },
		position: position(text, text.indexOf('xph.self') + 5),
	});
	expect(definition).toMatchObject({ uri });
});
