// VS Code supplies this module in the extension host.
// @ts-ignore
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
export function activate(context: any) {
	const child = spawn(vscode.workspace.getConfiguration('xph').get('executable', 'xph'), ['lsp'], {
		shell: false,
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	});
	const output = vscode.window.createOutputChannel('xph'),
		diagnostics = vscode.languages.createDiagnosticCollection('xph');
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
		rootUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
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
					return r?.items?.map(
						(i: any) => new vscode.CompletionItem(i.label, vscode.CompletionItemKind.Property),
					);
				},
			},
			'.',
		),
		vscode.languages.registerHoverProvider('xph', {
			async provideHover(d: any, p: any) {
				await ready;
				const r = await request('textDocument/hover', params(d, p));
				return r ? new vscode.Hover(new vscode.MarkdownString(r.contents.value)) : null;
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
							vscode.Uri.parse(location.uri),
							new vscode.Range(
								location.range.start.line,
								location.range.start.character,
								location.range.end.line,
								location.range.end.character,
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
