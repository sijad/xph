import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildWebsite } from './build-website.mjs';

export async function previewWebsite({ port = 8000, outDir } = {}) {
	const built = await buildWebsite({ outDir });
	const files = {
		'/': ['index.html', 'text/html; charset=utf-8'],
		'/index.html': ['index.html', 'text/html; charset=utf-8'],
		'/style.css': ['style.css', 'text/css; charset=utf-8'],
		'/site.js': ['site.js', 'text/javascript; charset=utf-8'],
		'/favicon.svg': ['favicon.svg', 'image/svg+xml'],
	};
	const server = createServer(async (request, response) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.writeHead(405, { Allow: 'GET, HEAD' }).end();
			return;
		}
		try {
			const file = files[new URL(request.url, 'http://localhost').pathname];
			if (!file) {
				response.writeHead(404).end('Not found');
				return;
			}
			const body = await readFile(resolve(built.outDir, file[0]));
			response.writeHead(200, {
				'Content-Type': file[1],
				'Content-Length': body.length,
				'Cache-Control': 'no-store',
			});
			response.end(request.method === 'HEAD' ? undefined : body);
		} catch {
			response.writeHead(500).end('Could not read preview file');
		}
	});
	server.listen(port, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { port: { type: 'string', default: '8000' } } });
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('--port must be an integer between 1 and 65535.');
	const server = await previewWebsite({ port });
	console.log(`Website preview: http://localhost:${server.address().port}/`);
	console.log('Press Ctrl+C to stop. Restart this command after editing the website.');
}
