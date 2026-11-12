import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { DiagnosticsWorker } from '../packages/language-server/src/diagnostics.js';

const entry = new URL(
	'data:text/javascript,' +
		encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
parentPort.on('message', ({ id, config }) => {
  if (!id) return;
  writeFileSync(config.root, 'started');
  // Deliberately occupy the compiler thread, rather than simulating asynchronous IO.
  const end = performance.now() + 1200;
  while (performance.now() < end) {}
  parentPort.postMessage({ id, error: 'slow diagnostics finished' });
});
`),
);

it('formats CSS edits while scheduled diagnostics are doing synchronous work', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-diagnostics-'));
	const marker = join(root, 'started');
	const messages: any[] = [];
	const server = new LanguageServer((message) => messages.push(message), { root: marker });
	server['diagnosticsWorker'] = new DiagnosticsWorker(entry);
	const uri = pathToFileURL(resolve('Responsive.xph')).href;
	const text = '<div><p>hello</p></div><style>.card { color: red; }</style>';
	server.documents.set(uri, { text, version: 1 });
	try {
		server.schedule(uri);
		await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toBe('started');
		await server.handle({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version: 2 },
				contentChanges: [{ text: text.replace('color: red', 'color: blue') }],
			},
		});
		await server.handle({
			id: 1,
			method: 'textDocument/formatting',
			params: { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
		});
		expect(messages.find((message) => message.id === 1).result[0].newText).toContain(
			'<p>hello</p>',
		);
		expect(messages.some((message) => message.method === 'window/logMessage')).toBe(false);
		expect(messages.find((message) => message.id === 1).result[0].newText).toContain(
			'color: blue;',
		);
		await expect
			.poll(
				() =>
					messages.some((message) =>
						message.params?.message?.includes('slow diagnostics finished'),
					),
				{ timeout: 5000 },
			)
			.toBe(true);
	} finally {
		await server.handle({ id: 99, method: 'shutdown', params: {} });
		await rm(root, { recursive: true, force: true });
	}
});

it('rejects cancelled diagnostics without waiting for the busy compiler', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-diagnostics-cancel-'));
	const marker = join(root, 'started');
	const worker = new DiagnosticsWorker(entry);
	const abort = new AbortController();
	try {
		const job = worker.run(
			{ uri: 'file:///cancel.xph', config: { root: marker }, documents: [] },
			abort.signal,
		);
		const cancelled = expect(job).rejects.toThrow('Diagnostics cancelled');
		await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toBe('started');
		abort.abort();
		await cancelled;
	} finally {
		worker.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
