// Minimal stdio PHP backend used to exercise the real bridge transport.
let buffer = Buffer.alloc(0);
const documents = new Map();
const send = (message) => {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const point = (text, index) => {
	const lines = text.slice(0, index).split('\n');
	return { line: lines.length - 1, character: lines.at(-1).length };
};
process.stdin.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf('\r\n\r\n');
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const { id, method, params } = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
		buffer = buffer.subarray(end + 4 + length);
		if (method === 'initialize')
			send({
				id,
				result: {
					capabilities: { textDocumentSync: 1, codeActionProvider: { resolveProvider: true } },
				},
			});
		if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
			const doc = params.textDocument;
			const text = doc.text ?? params.contentChanges[0].text;
			documents.set(doc.uri, text);
			const start = text.indexOf('$local');
			const range = { start: point(text, start), end: point(text, start + 6) };
			send({
				method: 'textDocument/publishDiagnostics',
				params: {
					uri: doc.uri,
					version: doc.version,
					diagnostics: [
						{ range, severity: 2, message: 'Mapped PHP diagnostic' },
						{
							range: { start: point(text, 0), end: point(text, 5) },
							severity: 1,
							message: 'Generated wrapper diagnostic',
						},
					],
				},
			});
		}
		if (method === 'textDocument/didClose') documents.delete(params.textDocument.uri);
		if (method === 'textDocument/completion') {
			const text = documents.get(params.textDocument.uri);
			const expected = point(text, text.indexOf('$local') + 6);
			const range = { start: point(text, text.indexOf('$local')), end: expected };
			send({
				id,
				result: {
					isIncomplete: true,
					items:
						expected.line === params.position.line &&
						expected.character === params.position.character
							? [
									{
										label: '$local',
										kind: 6,
										insertTextFormat: 2,
										textEdit: { range, newText: '$local' },
										detail: 'PHP variable',
									},
									{
										label: 'unsafe',
										textEdit: {
											range: { start: point(text, 0), end: point(text, 5) },
											newText: 'bad',
										},
									},
								]
							: [],
				},
			});
		}
		if (method === 'textDocument/formatting') {
			const text = documents.get(params.textDocument.uri);
			const formatted = text.replace(/\$local\s*=\s*/g, '$local = ');
			send({
				id,
				result: [
					{ range: { start: point(text, 0), end: point(text, text.length) }, newText: formatted },
				],
			});
		}
		if (method === 'textDocument/codeAction') {
			const uri = params.textDocument.uri,
				text = documents.get(uri);
			const start = text.indexOf('$local');
			const range = { start: point(text, start), end: point(text, start + 6) };
			const edit = { range, newText: '$renamed' };
			const unsafe = { range: { start: point(text, 0), end: point(text, 5) }, newText: 'bad' };
			const validContext =
				params.context.only?.[0] === 'source.fixAll' ||
				(params.range.start.line === range.start.line &&
					params.context.only?.[0] === 'quickfix' &&
					params.context.diagnostics[0]?.range.start.line === range.start.line);
			send({
				id,
				result: validContext
					? [
							{
								title: 'Rename local',
								kind: 'quickfix',
								isPreferred: true,
								edit: { changes: { [uri]: [edit] } },
							},
							{ title: 'Resolve fix', kind: 'quickfix', data: { uri, edit } },
							{ title: 'Unsafe mixed fix', edit: { changes: { [uri]: [edit, unsafe] } } },
							{ title: 'External file', edit: { changes: { 'file:///other.php': [edit] } } },
							{
								title: 'Command fix',
								command: { command: 'backend.command' },
								edit: { changes: { [uri]: [edit] } },
							},
							{ title: 'Resource operation', edit: { documentChanges: [{ kind: 'delete', uri }] } },
							{
								title: 'Stale fix',
								edit: { documentChanges: [{ textDocument: { uri, version: 99 }, edits: [edit] }] },
							},
						]
					: [],
			});
		}
		if (method === 'codeAction/resolve')
			send({
				id,
				result: {
					...params,
					edit: {
						documentChanges: [
							{ textDocument: { uri: params.data.uri, version: 1 }, edits: [params.data.edit] },
						],
					},
				},
			});
		if (method === 'textDocument/hover')
			send({ id, result: { contents: { kind: 'markdown', value: 'PHP hover' } } });
		if (method === 'textDocument/definition') {
			const text = documents.get(params.textDocument.uri);
			const start = text.indexOf('$local');
			send({
				id,
				result: [
					{
						uri: params.textDocument.uri,
						range: { start: point(text, start), end: point(text, start + 6) },
					},
					{ uri: 'file:///vendor/helper.php', range: { start: point('', 0), end: point('', 0) } },
				],
			});
		}
	}
});
