import { Worker } from 'node:worker_threads';
import type { CompileResult, Config } from 'xph';

export type DiagnosticsRequest = {
	uri: string;
	config: Pick<Config, 'root' | 'php' | 'debug'>;
	documents: [string, { text: string; version: number }][];
};

/** Keep synchronous compiler work away from the JSON-RPC transport. */
export class DiagnosticsWorker {
	private worker?: Worker;
	private sequence = 0;
	private idle?: ReturnType<typeof setTimeout>;
	private pending = new Map<
		number,
		{
			resolve: (result: CompileResult) => void;
			reject: (error: Error) => void;
			cleanup: () => void;
		}
	>();
	constructor(private entry: URL) {}
	run(request: DiagnosticsRequest, signal: AbortSignal): Promise<CompileResult> {
		if (signal.aborted) return Promise.reject(new Error('Diagnostics cancelled'));
		clearTimeout(this.idle);
		if (!this.worker) {
			const worker = new Worker(this.entry, {
				workerData: { xphDiagnostics: true },
				execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
			});
			this.worker = worker;
			worker.on('message', ({ id, result, error }) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				pending.cleanup();
				if (error) pending.reject(new Error(error));
				else pending.resolve(result);
				if (!this.pending.size) {
					this.idle = setTimeout(() => this.dispose(), 1000);
					this.idle.unref();
				}
			});
			worker.on('error', (error) => {
				if (this.worker === worker)
					this.dispose(error instanceof Error ? error : new Error(String(error)));
			});
			worker.on('exit', (code) => {
				if (this.worker === worker) this.dispose(new Error(`Diagnostics worker exited (${code})`));
			});
			worker.unref();
		}
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const cancel = () => {
				this.pending.delete(id);
				this.worker?.postMessage({ cancel: id });
				reject(new Error('Diagnostics cancelled'));
				if (!this.pending.size) {
					// Give the worker time to abort any running PHP check before teardown.
					this.idle = setTimeout(() => this.dispose(), 1000);
					this.idle.unref();
				}
			};
			this.pending.set(id, {
				resolve,
				reject,
				cleanup: () => signal.removeEventListener('abort', cancel),
			});
			signal.addEventListener('abort', cancel, { once: true });
			this.worker!.postMessage({ id, ...request });
		});
	}
	dispose(error = new Error('Diagnostics worker stopped')) {
		clearTimeout(this.idle);
		const worker = this.worker;
		this.worker = undefined;
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
		void worker?.terminate();
	}
}
