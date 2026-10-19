import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { position, type CompileResult, type Config, type Mapping } from 'xph';

type Point = { line: number; character: number };
type Range = { start: Point; end: Point };
type Virtual = {
	source: string;
	code: string;
	mappings: Mapping[];
	version: number;
	diagnostics?: any[];
};
export function offset(text: string, point: Point) {
	return (
		text
			.split('\n')
			.slice(0, point.line)
			.reduce((n, line) => n + line.length + 1, 0) + point.character
	);
}
export class PHPClient {
	private child?: ChildProcessWithoutNullStreams;
	private ready?: Promise<unknown>;
	private sequence = 0;
	private buffer = Buffer.alloc(0);
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private documents = new Map<string, Virtual>();
	private revisions = new Map<string, number>();
	private stopped = false;
	private resolveActions = false;
	constructor(
		private config: NonNullable<Config['phpLanguageServer']>,
		private rootUri: string | undefined,
		private diagnostics: (uri: string, version: number, items: any[]) => void,
		private log: (message: string) => void,
	) {}
	private send(method: string, params: any, id?: number) {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method,
			params,
			...(id === undefined ? {} : { id }),
		});
		this.child?.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}
	private request(method: string, params: any): Promise<any> {
		return new Promise((resolve) => {
			const id = ++this.sequence;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve(null);
			}, 10000);
			this.pending.set(id, { resolve, timer });
			this.send(method, params, id);
		});
	}
	private start() {
		if (this.stopped)
			return Promise.reject(
				new Error('PHP language server has stopped. Restart xph lsp to reconnect.'),
			);
		if (this.ready) return this.ready;
		this.child = spawn(this.config.command, this.config.args ?? ['--stdio'], {
			shell: false,
			cwd: this.rootUri?.startsWith('file:') ? fileURLToPath(this.rootUri) : undefined,
		});
		this.child.stdin.on('error', () => {});
		this.child.stderr.on('data', (chunk) => this.log(chunk.toString()));
		this.child.on('error', (error) => {
			this.log(`PHP language server: ${error.message}`);
			this.dispose();
		});
		this.child.on('exit', () => this.dispose());
		this.child.stdout.on('data', (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			while (true) {
				const end = this.buffer.indexOf('\r\n\r\n');
				if (end < 0) return;
				const length = Number(
					/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1],
				);
				if (!Number.isFinite(length)) {
					this.dispose();
					return;
				}
				if (this.buffer.length < end + 4 + length) return;
				const body = this.buffer.subarray(end + 4, end + 4 + length).toString();
				this.buffer = this.buffer.subarray(end + 4 + length);
				try {
					this.receive(JSON.parse(body));
				} catch (error) {
					this.log(String(error));
				}
			}
		});
		this.ready = this.request('initialize', {
			processId: process.pid,
			rootUri: this.rootUri ?? null,
			capabilities: {
				textDocument: {
					synchronization: { dynamicRegistration: false },
					completion: { completionItem: { snippetSupport: true } },
					codeAction: {
						codeActionLiteralSupport: {
							codeActionKind: { valueSet: ['quickfix', 'source.fixAll'] },
						},
						resolveSupport: { properties: ['edit'] },
					},
				},
			},
			initializationOptions: this.config.initializationOptions,
		}).then((result) => {
			if (!result) throw new Error('PHP language server initialization failed.');
			this.resolveActions = !!result.capabilities?.codeActionProvider?.resolveProvider;
			this.send('initialized', {});
			this.send('workspace/didChangeConfiguration', { settings: this.config.settings ?? {} });
		});
		return this.ready;
	}
	private receive(message: any) {
		if (message.method && message.id !== undefined) {
			const result =
				message.method === 'workspace/configuration'
					? message.params.items.map(
							(item: any) =>
								item.section
									?.split('.')
									.reduce((value: any, key: string) => value?.[key], this.config.settings) ?? null,
						)
					: null;
			const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
			this.child?.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		} else if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				pending.resolve(message.result ?? null);
				this.pending.delete(message.id);
			}
		} else if (message.method === 'textDocument/publishDiagnostics') {
			const { uri, version, diagnostics } = message.params;
			const doc = this.documents.get(uri);
			if (!doc || (version !== undefined && version !== doc.version)) return;
			doc.diagnostics = diagnostics;
			const items = diagnostics.flatMap((item: any) => {
				const range = this.mapRange(doc, item.range);
				return range ? [{ ...item, range, source: 'php' }] : [];
			});
			this.diagnostics(uri.slice(0, -4), doc.version, items);
		}
	}
	async sync(uri: string, source: string, version: number, result: CompileResult) {
		const revision = (this.revisions.get(uri) ?? 0) + 1;
		this.revisions.set(uri, revision);
		await this.start();
		if (this.stopped || this.revisions.get(uri) !== revision) return;
		const target = uri + '.php';
		const previous = this.documents.get(target);
		if (previous && previous.version >= version) return;
		// Only verbatim spans can safely carry PHP edits and positions.
		const mappings = result.mappings.filter(
			(m) =>
				source.slice(m.sourceStart, m.sourceEnd) ===
				result.php.slice(m.generatedStart, m.generatedEnd),
		);
		this.documents.set(target, { source, code: result.php, mappings, version });
		this.send(
			previous ? 'textDocument/didChange' : 'textDocument/didOpen',
			previous
				? { textDocument: { uri: target, version }, contentChanges: [{ text: result.php }] }
				: { textDocument: { uri: target, version, languageId: 'php', text: result.php } },
		);
	}
	private mapRange(doc: Virtual, range: Range): Range | null {
		const start = offset(doc.code, range.start),
			end = offset(doc.code, range.end);
		const mapping = doc.mappings.find((m) => start >= m.generatedStart && end <= m.generatedEnd);
		return mapping
			? {
					start: position(doc.source, mapping.sourceStart + start - mapping.generatedStart),
					end: position(doc.source, mapping.sourceStart + end - mapping.generatedStart),
				}
			: null;
	}
	async format(
		uri: string,
		source: string,
		blocks: { code: string; contentStart: number }[],
		options: any,
	) {
		await this.start();
		const edits = [];
		for (const block of blocks) {
			// Format each block independently so compiler wrapper indentation cannot leak into source.
			const target = uri + `.format-${++this.sequence}.php`;
			const code = '<?php\n' + block.code;
			this.send('textDocument/didOpen', {
				textDocument: { uri: target, languageId: 'php', version: 1, text: code },
			});
			try {
				const response = await this.request('textDocument/formatting', {
					textDocument: { uri: target },
					options,
				});
				if (!response?.length) continue;
				const changes = response
					.map((edit: any) => ({
						start: offset(code, edit.range.start),
						end: offset(code, edit.range.end),
						text: edit.newText,
					}))
					.sort((a: any, b: any) => b.start - a.start);
				let formatted = code,
					boundary = code.length,
					valid = true;
				for (const change of changes) {
					if (change.start < 0 || change.end < change.start || change.end > boundary) {
						valid = false;
						break;
					}
					formatted = formatted.slice(0, change.start) + change.text + formatted.slice(change.end);
					boundary = change.start;
				}
				if (!valid || !formatted.startsWith('<?php')) continue;
				const eol = source.includes('\r\n') ? '\r\n' : '\n';
				const leading =
					/^[ \t]*\r?\n/.exec(block.code)?.[0] ?? /^[ \t]*/.exec(block.code)?.[0] ?? '';
				const trailing =
					/\r?\n[ \t]*$/.exec(block.code)?.[0] ?? /[ \t]*$/.exec(block.code)?.[0] ?? '';
				const newText = leading + formatted.slice(5).trim().replace(/\r?\n/g, eol) + trailing;
				if (newText !== block.code)
					edits.push({
						range: {
							start: position(source, block.contentStart),
							end: position(source, block.contentStart + block.code.length),
						},
						newText,
					});
			} finally {
				this.send('textDocument/didClose', { textDocument: { uri: target } });
			}
		}
		return edits;
	}
	async codeActions(uri: string, range: Range, context: any, version: number) {
		const target = uri + '.php',
			doc = this.documents.get(target);
		if (!doc || doc.version !== version) return [];
		const start = offset(doc.source, range.start),
			end = offset(doc.source, range.end);
		// Limit selection requests to one verbatim PHP block.
		const mapping = doc.mappings.find((m) => start >= m.sourceStart && end <= m.sourceEnd);
		const fixAll = context?.only?.some(
			(kind: string) =>
				kind === 'source' || kind === 'source.fixAll' || kind.startsWith('source.fixAll.'),
		);
		if (!mapping && !fixAll) return [];
		const generatedRange = mapping
			? {
					start: position(doc.code, mapping.generatedStart + start - mapping.sourceStart),
					end: position(doc.code, mapping.generatedStart + end - mapping.sourceStart),
				}
			: { start: { line: 0, character: 0 }, end: position(doc.code, doc.code.length) };
		const diagnostics = (doc.diagnostics ?? []).filter((diagnostic) => {
			const mapped = this.mapRange(doc, diagnostic.range);
			return (
				mapped && offset(doc.source, mapped.end) >= start && offset(doc.source, mapped.start) <= end
			);
		});
		const response = await this.request('textDocument/codeAction', {
			textDocument: { uri: target },
			range: generatedRange,
			context: { diagnostics, only: context?.only, triggerKind: context?.triggerKind },
		});
		const actions = [];
		for (let action of response ?? []) {
			if (this.documents.get(target) !== doc) return [];
			if (!action.edit && action.data !== undefined && this.resolveActions) {
				action = await this.request('codeAction/resolve', action);
			}
			if (!action?.edit || action.command || action.disabled) continue;
			const edits: any[] = [];
			let valid = true;
			const add = (editUri: string, changes: any[], editVersion?: number | null) => {
				if (editUri !== target || (editVersion != null && editVersion !== version)) {
					valid = false;
					return;
				}
				for (const edit of changes) {
					const mapped = this.mapRange(doc, edit.range);
					if (!mapped || edit.annotationId) {
						valid = false;
						return;
					}
					edits.push({ range: mapped, newText: edit.newText });
				}
			};
			for (const [editUri, changes] of Object.entries(action.edit.changes ?? {}))
				add(editUri, changes as any[]);
			for (const change of action.edit.documentChanges ?? []) {
				if (!change.textDocument) {
					valid = false;
					break;
				}
				add(change.textDocument.uri, change.edits, change.textDocument.version);
			}
			if (!valid || !edits.length) continue;
			actions.push({
				title: action.title,
				kind: action.kind,
				isPreferred: action.isPreferred,
				diagnostics: action.diagnostics?.flatMap((diagnostic: any) => {
					const mapped = this.mapRange(doc, diagnostic.range);
					return mapped ? [{ ...diagnostic, range: mapped, source: 'php' }] : [];
				}),
				edit: { documentChanges: [{ textDocument: { uri, version }, edits }] },
			});
		}
		return this.documents.get(target) === doc ? actions : [];
	}
	async query(method: string, uri: string, point: Point, version: number) {
		const target = uri + '.php',
			doc = this.documents.get(target);
		if (!doc || doc.version !== version) return null;
		const sourceOffset = offset(doc.source, point);
		const mapping = doc.mappings.find(
			(m) => sourceOffset >= m.sourceStart && sourceOffset <= m.sourceEnd,
		);
		if (!mapping) return null;
		const response = await this.request(method, {
			textDocument: { uri: target },
			position: position(doc.code, mapping.generatedStart + sourceOffset - mapping.sourceStart),
		});
		if (this.documents.get(target) !== doc || !response) return null;
		if (method === 'textDocument/hover') {
			const range = response.range && this.mapRange(doc, response.range);
			return { ...response, range: range ?? undefined };
		}
		if (method === 'textDocument/definition') {
			const locations = (Array.isArray(response) ? response : [response]).flatMap(
				(location: any) => {
					const locationUri = location.uri ?? location.targetUri;
					const virtual = this.documents.get(locationUri);
					if (!virtual) return [location];
					const range = this.mapRange(virtual, location.range ?? location.targetSelectionRange);
					return range ? [{ uri: locationUri.slice(0, -4), range }] : [];
				},
			);
			return locations.length ? locations : null;
		}
		const items = (Array.isArray(response) ? response : response.items).flatMap((item: any) => {
			const mapEdit = (edit: any) => {
				if (edit.range) {
					const range = this.mapRange(doc, edit.range);
					return range ? { ...edit, range } : null;
				}
				const insert = this.mapRange(doc, edit.insert),
					replace = this.mapRange(doc, edit.replace);
				return insert && replace ? { ...edit, insert, replace } : null;
			};
			const textEdit = item.textEdit && mapEdit(item.textEdit);
			const additionalTextEdits = item.additionalTextEdits?.map(mapEdit);
			if ((item.textEdit && !textEdit) || additionalTextEdits?.some((edit: any) => !edit))
				return [];
			return [{ ...item, textEdit, additionalTextEdits, command: undefined, data: undefined }];
		});
		return { isIncomplete: response.isIncomplete ?? false, items };
	}
	close(uri: string) {
		this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
		if (this.documents.delete(uri + '.php'))
			this.send('textDocument/didClose', { textDocument: { uri: uri + '.php' } });
	}
	dispose() {
		this.stopped = true;
		const child = this.child;
		this.child = undefined;
		child?.kill();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.pending.clear();
		this.documents.clear();
	}
}
