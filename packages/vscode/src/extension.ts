// VS Code supplies this module in the extension host.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { findProjectConfig } from './project.js';
import { installedIntelephense } from './php.js';

// The subset of LSP wire types this client reads from the xph language server.
interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}
interface LspTextEdit {
	range: LspRange;
	newText: string;
}
type LspMarkup = string | { language?: string; kind?: string; value: string };
interface LspCompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | { value: string };
	sortText?: string;
	filterText?: string;
	insertText?: string;
	insertTextFormat?: number;
	textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange };
	additionalTextEdits?: LspTextEdit[];
}
interface LspCodeAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	edit: { documentChanges: { textDocument: { uri: string }; edits: LspTextEdit[] }[] };
}
type LspLocation =
	| { uri: string; range: LspRange }
	| { targetUri: string; targetSelectionRange: LspRange };
interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
}

const toRange = (r: LspRange) =>
	new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
const toEdit = (edit: LspTextEdit) => new vscode.TextEdit(toRange(edit.range), edit.newText);

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('xph'),
		diagnostics = vscode.languages.createDiagnosticCollection('xph');
	const activeDocument = vscode.window.activeTextEditor?.document;
	const active =
		activeDocument?.languageId === 'xph'
			? activeDocument
			: vscode.workspace.textDocuments.find((document) => document.languageId === 'xph');
	const folder =
		(active && vscode.workspace.getWorkspaceFolder(active.uri)) ??
		vscode.workspace.workspaceFolders?.[0];
	const configuration = vscode.workspace.getConfiguration('xph', active?.uri);
	let configFile =
		active?.uri.scheme === 'file'
			? findProjectConfig(active.uri.fsPath, folder?.uri.fsPath)
			: folder && findProjectConfig(join(folder.uri.fsPath, '__xph__.xph'), folder.uri.fsPath);
	if (!configFile && folder) {
		const configs = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, '**/xph.config.ts'),
			'**/{node_modules,.git,dist}/**',
			2,
		);
		if (configs.length === 1) configFile = configs[0].fsPath;
		else if (configs.length > 1)
			output.appendLine(
				'Multiple xph projects found. Open a .xph file in the project you want and reload the window.',
			);
	}
	output.appendLine(
		`Starting xph with config: ${configFile || join(folder?.uri.fsPath ?? '.', 'xph.config.ts')}`,
	);
	const child = spawn(
		configuration.get('executable', 'xph'),
		['lsp', ...(configFile ? [configFile] : [])],
		{
			shell: false,
			cwd: configFile ? dirname(configFile) : folder?.uri.fsPath,
		},
	);
	let seq = 0,
		buffer = Buffer.alloc(0);
	const pending = new Map<number, (value: unknown) => void>();
	const send = (method: string, params: unknown, id?: number) => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method,
			params,
			...(id === undefined ? {} : { id }),
		});
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	// Results are trusted to match the LSP method's result type; null when the server exits.
	const request = <T>(method: string, params: unknown) =>
		new Promise<T | null>((resolve) => {
			const id = ++seq;
			pending.set(id, resolve as (value: unknown) => void);
			send(method, params, id);
		});
	child.stderr.on('data', (d) => output.append(d.toString()));
	child.on('error', (e) => {
		output.appendLine(e.message);
		vscode.window.showErrorMessage('Cannot start xph. Install xph and configure xph.executable.');
	});
	child.on('exit', () => {
		for (const done of pending.values()) done(null);
		pending.clear();
	});
	child.stdout.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const end = buffer.indexOf('\r\n\r\n');
			if (end < 0) return;
			const length = Number(
				/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
			);
			if (buffer.length < end + 4 + length) return;
			const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
			buffer = buffer.subarray(end + 4 + length);
			if (message.id !== undefined) {
				pending.get(message.id)?.(message.result);
				pending.delete(message.id);
			} else if (message.method === 'window/logMessage') {
				output.appendLine(message.params.message);
			} else if (message.method === 'textDocument/publishDiagnostics')
				diagnostics.set(
					vscode.Uri.parse(message.params.uri),
					message.params.diagnostics.map(
						(d: LspDiagnostic) =>
							new vscode.Diagnostic(
								toRange(d.range),
								d.message,
								d.severity === 1
									? vscode.DiagnosticSeverity.Error
									: vscode.DiagnosticSeverity.Warning,
							),
					),
				);
		}
	});
	const open = (d: vscode.TextDocument) => {
		if (d.languageId === 'xph')
			send('textDocument/didOpen', {
				textDocument: {
					uri: d.uri.toString(),
					languageId: 'xph',
					version: d.version,
					text: d.getText(),
				},
			});
	};
	const intelephense = vscode.workspace.getConfiguration('intelephense', active?.uri);
	const phpBackend = installedIntelephense(
		configuration.get('php.autoDetect', true)
			? vscode.extensions.getExtension('bmewburn.vscode-intelephense-client')?.extensionPath
			: undefined,
		intelephense.get<string>('runtime') || 'node',
	);
	if (phpBackend)
		output.appendLine(
			'Found installed Intelephense; using it unless the project config specifies a PHP backend.',
		);
	const ready = request('initialize', {
		processId: process.pid,
		rootUri: (configFile ? vscode.Uri.file(dirname(configFile)) : folder?.uri)?.toString(),
		initializationOptions: {
			phpLanguageServerFallback: phpBackend && {
				...phpBackend,
				settings: { intelephense: JSON.parse(JSON.stringify(intelephense)) },
			},
		},
	}).then(() => {
		send('initialized', {});
		vscode.workspace.textDocuments.forEach(open);
	});
	const params = (doc: vscode.TextDocument, pos: vscode.Position) => ({
		textDocument: { uri: doc.uri.toString() },
		position: { line: pos.line, character: pos.character },
	});
	context.subscriptions.push(
		output,
		diagnostics,
		{ dispose: () => child.kill() },
		vscode.workspace.onDidOpenTextDocument(async (d) => {
			await ready;
			open(d);
		}),
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.languageId === 'xph')
				send('textDocument/didChange', {
					textDocument: { uri: e.document.uri.toString(), version: e.document.version },
					contentChanges: [{ text: e.document.getText() }],
				});
		}),
		vscode.workspace.onDidCloseTextDocument((d) =>
			send('textDocument/didClose', { textDocument: { uri: d.uri.toString() } }),
		),
		vscode.languages.registerCompletionItemProvider(
			'xph',
			{
				async provideCompletionItems(d, p) {
					await ready;
					const r = await request<{ items?: LspCompletionItem[] }>(
						'textDocument/completion',
						params(d, p),
					);
					return r?.items?.map((i) => {
						const item = new vscode.CompletionItem(
							i.label,
							i.kind ? i.kind - 1 : vscode.CompletionItemKind.Property,
						);
						item.detail = i.detail;
						item.documentation =
							typeof i.documentation === 'string'
								? i.documentation
								: i.documentation
									? new vscode.MarkdownString(i.documentation.value)
									: undefined;
						item.sortText = i.sortText;
						item.filterText = i.filterText;
						const text = i.textEdit?.newText ?? i.insertText ?? i.label;
						item.insertText = i.insertTextFormat === 2 ? new vscode.SnippetString(text) : text;
						if (i.textEdit)
							item.range = i.textEdit.range
								? toRange(i.textEdit.range)
								: {
										inserting: toRange(i.textEdit.insert!),
										replacing: toRange(i.textEdit.replace!),
									};
						item.additionalTextEdits = i.additionalTextEdits?.map(toEdit);
						return item;
					});
				},
			},
			'.',
			'$',
			'>',
			':',
			'\\',
			'<',
			' ',
			'"',
			"'",
			'=',
		),
		vscode.languages.registerDocumentFormattingEditProvider('xph', {
			async provideDocumentFormattingEdits(document, options) {
				await ready;
				const version = document.version;
				const edits = await request<LspTextEdit[]>('textDocument/formatting', {
					textDocument: { uri: document.uri.toString() },
					options,
				});
				if (document.version !== version) return [];
				return (edits ?? []).map(toEdit);
			},
		}),
		vscode.languages.registerCodeActionsProvider(
			'xph',
			{
				async provideCodeActions(document, range, context) {
					await ready;
					const version = document.version;
					const actions = await request<LspCodeAction[]>('textDocument/codeAction', {
						textDocument: { uri: document.uri.toString() },
						range: {
							start: { line: range.start.line, character: range.start.character },
							end: { line: range.end.line, character: range.end.character },
						},
						context: {
							diagnostics: [],
							only: context.only ? [context.only.value] : undefined,
							triggerKind: context.triggerKind,
						},
					});
					if (document.version !== version) return [];
					return (actions ?? []).map((action) => {
						const item = new vscode.CodeAction(
							action.title,
							action.kind ? vscode.CodeActionKind.Empty.append(action.kind) : undefined,
						);
						item.isPreferred = action.isPreferred;
						item.edit = new vscode.WorkspaceEdit();
						for (const change of action.edit.documentChanges) {
							item.edit.set(vscode.Uri.parse(change.textDocument.uri), change.edits.map(toEdit));
						}
						return item;
					});
				},
			},
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.SourceFixAll,
				],
			},
		),
		vscode.languages.registerHoverProvider('xph', {
			async provideHover(d, p) {
				await ready;
				const r = await request<{ contents: LspMarkup | LspMarkup[] }>(
					'textDocument/hover',
					params(d, p),
				);
				if (!r) return null;
				const contents = (Array.isArray(r.contents) ? r.contents : [r.contents]).map((content) => {
					if (typeof content === 'string') return new vscode.MarkdownString(content);
					if (content.language)
						return new vscode.MarkdownString().appendCodeblock(content.value, content.language);
					return content.kind === 'plaintext'
						? new vscode.MarkdownString().appendText(content.value)
						: new vscode.MarkdownString(content.value);
				});
				return new vscode.Hover(contents);
			},
		}),
		vscode.languages.registerDefinitionProvider('xph', {
			async provideDefinition(d, p) {
				await ready;
				const r = await request<LspLocation | LspLocation[]>(
					'textDocument/definition',
					params(d, p),
				);
				if (!r) return null;
				return (Array.isArray(r) ? r : [r]).map((location) =>
					'uri' in location
						? new vscode.Location(vscode.Uri.parse(location.uri), toRange(location.range))
						: new vscode.Location(
								vscode.Uri.parse(location.targetUri),
								toRange(location.targetSelectionRange),
							),
				);
			},
		}),
	);
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.xph');
	const changed = (uri: vscode.Uri) =>
		send('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type: 2 }] });
	watcher.onDidChange(changed);
	watcher.onDidCreate(changed);
	watcher.onDidDelete(changed);
	context.subscriptions.push(watcher);
}
