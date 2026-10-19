import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { compile, analyzePHP, position, type CompileResult, type Config, type IR } from 'xph';
type Document = {
	text: string;
	version: number;
	result?: CompileResult;
	timer?: ReturnType<typeof setTimeout>;
	abort?: AbortController;
};
export class LanguageServer {
	documents = new Map<string, Document>();
	config: Config = { entries: [] };
	constructor(
		readonly send: (message: unknown) => void,
		config: Config = { entries: [] },
	) {
		this.config = config;
	}
	private async component(
		uri: string,
		source: string,
		active = new Set<string>(),
	): Promise<CompileResult> {
		if (active.has(uri)) throw new Error('Circular component import.');
		active.add(uri);
		const filename = fileURLToPath(uri);
		const first = await compile(source, { filename, contractsOnly: true });
		const components: Record<string, { id: string; props: CompileResult['props'] }> = {};
		for (const [name, path] of Object.entries(first.imports)) {
			try {
				const target = resolve(dirname(filename), path),
					url = pathToFileURL(target).href;
				const text = this.documents.get(url)?.text ?? (await readFile(target, 'utf8'));
				const result = await this.component(url, text, new Set(active));
				components[name] = { id: target, props: result.props };
			} catch (e) {
				first.diagnostics.push({
					message: (e as Error).message,
					severity: 'error',
					source: 'xph',
					start: 0,
					end: 1,
				});
			}
		}
		const result = await compile(source, { filename, components });
		result.diagnostics.push(...first.diagnostics);
		return result;
	}
	private publish(uri: string, doc: Document, result: CompileResult) {
		this.send({
			jsonrpc: '2.0',
			method: 'textDocument/publishDiagnostics',
			params: {
				uri,
				version: doc.version,
				diagnostics: result.diagnostics.map((d) => ({
					range: { start: position(doc.text, d.start), end: position(doc.text, d.end) },
					severity: d.severity === 'error' ? 1 : 2,
					source: d.source,
					message: d.message,
				})),
			},
		});
	}
	schedule(uri: string) {
		const doc = this.documents.get(uri);
		if (!doc) return;
		clearTimeout(doc.timer);
		doc.abort?.abort();
		const abort = new AbortController();
		doc.abort = abort;
		const version = doc.version;
		doc.timer = setTimeout(async () => {
			try {
				const result = await this.component(uri, doc.text);
				if (this.documents.get(uri) !== doc || doc.version !== version || abort.signal.aborted)
					return;
				doc.result = result;
				this.publish(uri, doc, result);
				const native = await analyzePHP(result, this.config, abort.signal);
				if (this.documents.get(uri) !== doc || doc.version !== version || abort.signal.aborted)
					return;
				const combined = { ...result, diagnostics: [...result.diagnostics, ...native] };
				this.publish(uri, doc, combined);
			} catch (e) {
				if (!abort.signal.aborted)
					this.send({
						jsonrpc: '2.0',
						method: 'window/logMessage',
						params: { type: 1, message: String(e) },
					});
			}
		}, 150);
	}
	async handle(message: any): Promise<void> {
		const { id, method, params } = message;
		let value: unknown = null;
		try {
			switch (method) {
				case 'initialize':
					this.config = { ...this.config, ...params.initializationOptions };
					value = {
						capabilities: {
							textDocumentSync: 1,
							completionProvider: { triggerCharacters: ['.'] },
							hoverProvider: true,
							definitionProvider: true,
						},
						serverInfo: { name: 'xph', version: '0.1.0' },
					};
					break;
				case 'initialized':
					return;
				case 'textDocument/didOpen': {
					const d = params.textDocument;
					this.documents.set(d.uri, { text: d.text, version: d.version });
					this.schedule(d.uri);
					return;
				}
				case 'textDocument/didChange': {
					const d = this.documents.get(params.textDocument.uri);
					if (d) {
						d.text = params.contentChanges.at(-1).text;
						d.version = params.textDocument.version;
					}
					for (const uri of this.documents.keys()) this.schedule(uri);
					return;
				}
				case 'workspace/didChangeWatchedFiles':
					for (const uri of this.documents.keys()) this.schedule(uri);
					return;
				case 'textDocument/didClose': {
					const uri = params.textDocument.uri,
						d = this.documents.get(uri);
					clearTimeout(d?.timer);
					d?.abort?.abort();
					this.documents.delete(uri);
					this.send({
						jsonrpc: '2.0',
						method: 'textDocument/publishDiagnostics',
						params: { uri, diagnostics: [] },
					});
					return;
				}
				case 'shutdown':
					for (const d of this.documents.values()) {
						clearTimeout(d.timer);
						d.abort?.abort();
					}
					break;
				case 'exit':
					process.exit(0);
					break;
				case 'textDocument/completion':
				case 'textDocument/hover':
				case 'textDocument/definition':
					value = await this.query(method, params);
					break;
				case '$/cancelRequest':
					return;
				default:
					if (id !== undefined)
						this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
					return;
			}
			if (id !== undefined) this.send({ jsonrpc: '2.0', id, result: value });
		} catch (e) {
			if (id !== undefined)
				this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } });
		}
	}
	async query(method: string, params: any) {
		const uri = params.textDocument.uri,
			doc = this.documents.get(uri);
		if (!doc) return null;
		const filename = fileURLToPath(uri) + '.tsx';
		const offset =
			doc.text
				.split('\n')
				.slice(0, params.position.line)
				.reduce((n, s) => n + s.length + 1, 0) + params.position.character;
		// Complete a trailing dot before handing the template to the strict Astro parser.
		const completionSource =
			method === 'textDocument/completion' &&
			doc.text.slice(0, offset).endsWith('.') &&
			!/\w/.test(doc.text[offset] ?? '')
				? doc.text.slice(0, offset) + '__xph_completion' + doc.text.slice(offset)
				: doc.text;
		const result = await this.component(uri, completionSource);
		const componentLocation = (name: string) => {
			const path = result.imports[name];
			return path
				? {
						uri: pathToFileURL(resolve(dirname(fileURLToPath(uri)), path)).href,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
					}
				: null;
		};
		if (method === 'textDocument/definition') {
			const contains = (start: number, end: number) => offset >= start && offset <= end;
			const findComponent = (nodes: IR[]): string | undefined => {
				for (const node of nodes) {
					if (node.kind === 'element') {
						const opening = node.start + 1;
						const closing = doc.text.lastIndexOf('</' + node.name, node.end);
						if (
							node.component &&
							(contains(opening, opening + node.name.length) ||
								(closing >= node.start && contains(closing + 2, closing + 2 + node.name.length)))
						)
							return node.name;
					}
					if ('children' in node) {
						const name = findComponent(node.children);
						if (name) return name;
					}
					if (node.kind === 'branch') {
						const name = findComponent([...node.yes, ...node.no]);
						if (name) return name;
					}
				}
			};
			const component = findComponent(result.ir);
			if (component) return componentLocation(component);
			const front = /^---[^\S\r\n]*\r?\n([\s\S]*?)^---/m.exec(doc.text);
			if (front?.index === 0) {
				const start = front[0].indexOf('\n') + 1;
				const file = ts.createSourceFile('frontmatter.ts', front[1], ts.ScriptTarget.Latest, true);
				for (const statement of file.statements) {
					if (!ts.isImportDeclaration(statement)) continue;
					const name = statement.importClause?.name;
					if (
						name &&
						result.imports[name.text] &&
						(contains(start + name.getStart(file), start + name.end) ||
							contains(
								start + statement.moduleSpecifier.getStart(file),
								start + statement.moduleSpecifier.end,
							))
					)
						return componentLocation(name.text);
				}
			}
		}
		const mapping = result.virtual.mappings.find(
			(m) => offset >= m.sourceStart && offset <= m.sourceEnd,
		);
		if (!mapping) return null;
		const pos = mapping.generatedStart + offset - mapping.sourceStart;
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [filename],
			getScriptVersion: () => String(doc.version),
			getScriptSnapshot: (n) => {
				const text =
					n === filename
						? result.virtual.code
						: (this.documents.get(pathToFileURL(n).href)?.text ?? ts.sys.readFile(n));
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getCurrentDirectory: () => dirname(filename),
			getCompilationSettings: () => ({
				strict: true,
				target: ts.ScriptTarget.ES2022,
				jsx: ts.JsxEmit.Preserve,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				types: [],
			}),
			getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
			fileExists: (n) => this.documents.has(pathToFileURL(n).href) || ts.sys.fileExists(n),
			readFile: (n) => this.documents.get(pathToFileURL(n).href)?.text ?? ts.sys.readFile(n),
		};
		const service = ts.createLanguageService(host);
		try {
			if (method === 'textDocument/completion') {
				let entries = service.getCompletionsAtPosition(filename, pos, {})?.entries ?? [];
				const program = service.getProgram()!;
				const file = program.getSourceFile(filename)!;
				const checker = program.getTypeChecker();
				let receiver: ts.Expression | undefined;
				const findReceiver = (node: ts.Node) => {
					if (
						ts.isPropertyAccessExpression(node) &&
						pos >= node.name.getFullStart() &&
						pos <= node.name.end
					)
						receiver = node.expression;
					ts.forEachChild(node, findReceiver);
				};
				findReceiver(file);
				const frontEnd = doc.text.startsWith('---') ? doc.text.indexOf('\n---', 3) + 4 : 0;
				if (receiver && offset > frontEnd) {
					const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
					const types = type.isUnion() ? type.types : [type];
					entries = entries.filter((entry) =>
						types.every((part) => {
							if (checker.isArrayType(part)) return entry.name === 'length' || entry.name === 'map';
							if (
								part.flags &
								(ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)
							)
								return false;
							const property = checker.getPropertyOfType(part, entry.name);
							return (
								property?.declarations?.some(
									(declaration) => !program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
								) ?? false
							);
						}),
					);
				}
				return {
					isIncomplete: false,
					items: entries.map((e) => ({
						label: e.name,
						kind: e.kind === 'property' ? 10 : 6,
						sortText: e.sortText,
					})),
				};
			}
			if (method === 'textDocument/definition') {
				const locations = [];
				for (const definition of service.getDefinitionAtPosition(filename, pos) ?? []) {
					if (definition.fileName === filename) {
						const target = result.virtual.mappings.find(
							(m) =>
								definition.textSpan.start >= m.generatedStart &&
								definition.textSpan.start < m.generatedEnd,
						);
						if (!target) {
							const location = componentLocation(definition.name);
							if (location) locations.push(location);
							continue;
						}
						const start = target.sourceStart + definition.textSpan.start - target.generatedStart;
						locations.push({
							uri,
							range: {
								start: position(doc.text, start),
								end: position(
									doc.text,
									Math.min(target.sourceEnd, start + definition.textSpan.length),
								),
							},
						});
					} else {
						const text =
							this.documents.get(pathToFileURL(definition.fileName).href)?.text ??
							ts.sys.readFile(definition.fileName);
						if (text === undefined) continue;
						locations.push({
							uri: pathToFileURL(definition.fileName).href,
							range: {
								start: position(text, definition.textSpan.start),
								end: position(text, definition.textSpan.start + definition.textSpan.length),
							},
						});
					}
				}
				return locations.length ? locations : null;
			}
			const info = service.getQuickInfoAtPosition(filename, pos);
			return info
				? {
						contents: {
							kind: 'markdown',
							value:
								'```typescript\n' +
								ts.displayPartsToString(info.displayParts) +
								'\n```\n' +
								ts.displayPartsToString(info.documentation),
						},
					}
				: null;
		} finally {
			service.dispose();
		}
	}
}
export function start(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
	config: Config = { entries: [] },
) {
	const server = new LanguageServer((message) => {
		const body = JSON.stringify(message);
		output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}, config);
	let buffer = Buffer.alloc(0);
	input.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const end = buffer.indexOf('\r\n\r\n');
			if (end < 0) return;
			const size = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString());
			if (!size) {
				buffer = Buffer.alloc(0);
				return;
			}
			const length = Number(size[1]);
			if (buffer.length < end + 4 + length) return;
			const body = buffer.subarray(end + 4, end + 4 + length);
			buffer = buffer.subarray(end + 4 + length);
			try {
				void server.handle(JSON.parse(body.toString()));
			} catch {
				const body = JSON.stringify({
					jsonrpc: '2.0',
					id: null,
					error: { code: -32700, message: 'Parse error' },
				});
				output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
			}
		}
	});
	return server;
}
