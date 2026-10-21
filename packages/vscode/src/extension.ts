// VS Code supplies this module in the extension host.
// @ts-ignore
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { findProjectConfig } from './project.js';
export async function activate(context: any) {
	const output = vscode.window.createOutputChannel('xph'),
		diagnostics = vscode.languages.createDiagnosticCollection('xph');
	const activeDocument = vscode.window.activeTextEditor?.document;
	const active =
		activeDocument?.languageId === 'xph'
			? activeDocument
			: vscode.workspace.textDocuments.find((document: any) => document.languageId === 'xph');
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
	const pending = new Map<number, (value: any) => void>();
	const send = (method: string, params: any, id?: number) => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method,
			params,
			...(id === undefined ? {} : { id }),
		});
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const request = (method: string, params: any) =>
		new Promise<any>((resolve) => {
			const id = ++seq;
			pending.set(id, resolve);
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
						(d: any) =>
							new vscode.Diagnostic(
								new vscode.Range(
									d.range.start.line,
									d.range.start.character,
									d.range.end.line,
									d.range.end.character,
								),
								d.message,
								d.severity === 1
									? vscode.DiagnosticSeverity.Error
									: vscode.DiagnosticSeverity.Warning,
							),
					),
				);
		}
	});
	const open = (d: any) => {
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
	const ready = request('initialize', {
		processId: process.pid,
		rootUri: (configFile ? vscode.Uri.file(dirname(configFile)) : folder?.uri)?.toString(),
	}).then(() => {
		send('initialized', {});
		vscode.workspace.textDocuments.forEach(open);
	});
	const params = (doc: any, pos: any) => ({
		textDocument: { uri: doc.uri.toString() },
		position: { line: pos.line, character: pos.character },
	});
	context.subscriptions.push(
		output,
		diagnostics,
		{ dispose: () => child.kill() },
		vscode.workspace.onDidOpenTextDocument(async (d: any) => {
			await ready;
			open(d);
		}),
		vscode.workspace.onDidChangeTextDocument((e: any) => {
			if (e.document.languageId === 'xph')
				send('textDocument/didChange', {
					textDocument: { uri: e.document.uri.toString(), version: e.document.version },
					contentChanges: [{ text: e.document.getText() }],
				});
		}),
		vscode.workspace.onDidCloseTextDocument((d: any) =>
			send('textDocument/didClose', { textDocument: { uri: d.uri.toString() } }),
		),
		vscode.languages.registerCompletionItemProvider(
			'xph',
			{
				async provideCompletionItems(d: any, p: any) {
					await ready;
					const r = await request('textDocument/completion', params(d, p));
					const range = (r: any) =>
						new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
					return r?.items?.map((i: any) => {
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
								? range(i.textEdit.range)
								: { inserting: range(i.textEdit.insert), replacing: range(i.textEdit.replace) };
						item.additionalTextEdits = i.additionalTextEdits?.map(
							(edit: any) => new vscode.TextEdit(range(edit.range), edit.newText),
						);
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
			async provideDocumentFormattingEdits(document: any, options: any) {
				await ready;
				const version = document.version;
				const edits = await request('textDocument/formatting', {
					textDocument: { uri: document.uri.toString() },
					options,
				});
				if (document.version !== version) return [];
				return (edits ?? []).map(
					(edit: any) =>
						new vscode.TextEdit(
							new vscode.Range(
								edit.range.start.line,
								edit.range.start.character,
								edit.range.end.line,
								edit.range.end.character,
							),
							edit.newText,
						),
				);
			},
		}),
		vscode.languages.registerCodeActionsProvider(
			'xph',
			{
				async provideCodeActions(document: any, range: any, context: any) {
					await ready;
					const version = document.version;
					const actions = await request('textDocument/codeAction', {
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
					return (actions ?? []).map((action: any) => {
						const item = new vscode.CodeAction(
							action.title,
							action.kind ? new vscode.CodeActionKind(action.kind) : undefined,
						);
						item.isPreferred = action.isPreferred;
						item.edit = new vscode.WorkspaceEdit();
						for (const change of action.edit.documentChanges) {
							item.edit.set(
								vscode.Uri.parse(change.textDocument.uri),
								change.edits.map(
									(edit: any) =>
										new vscode.TextEdit(
											new vscode.Range(
												edit.range.start.line,
												edit.range.start.character,
												edit.range.end.line,
												edit.range.end.character,
											),
											edit.newText,
										),
								),
							);
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
			async provideHover(d: any, p: any) {
				await ready;
				const r = await request('textDocument/hover', params(d, p));
				if (!r) return null;
				const contents = (Array.isArray(r.contents) ? r.contents : [r.contents]).map(
					(content: any) => {
						if (typeof content === 'string') return new vscode.MarkdownString(content);
						if (content.language)
							return new vscode.MarkdownString().appendCodeblock(content.value, content.language);
						return content.kind === 'plaintext'
							? new vscode.MarkdownString().appendText(content.value)
							: new vscode.MarkdownString(content.value);
					},
				);
				return new vscode.Hover(contents);
			},
		}),
		vscode.languages.registerDefinitionProvider('xph', {
			async provideDefinition(d: any, p: any) {
				await ready;
				const r = await request('textDocument/definition', params(d, p));
				if (!r) return null;
				return (Array.isArray(r) ? r : [r]).map(
					(location: any) =>
						new vscode.Location(
							vscode.Uri.parse(location.uri ?? location.targetUri),
							new vscode.Range(
								(location.range ?? location.targetSelectionRange).start.line,
								(location.range ?? location.targetSelectionRange).start.character,
								(location.range ?? location.targetSelectionRange).end.line,
								(location.range ?? location.targetSelectionRange).end.character,
							),
						),
				);
			},
		}),
	);
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.xph');
	const changed = (uri: any) =>
		send('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type: 2 }] });
	watcher.onDidChange(changed);
	watcher.onDidCreate(changed);
	watcher.onDidDelete(changed);
	context.subscriptions.push(watcher);
}
