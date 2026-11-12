import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dev, inside, type BuildContext, type DevServer } from '../packages/xph-dev/src/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((task) => task()));
});
const silent = {
	info() {},
	warn() {},
	error() {},
	dim: (text: string) => text,
	bold: (text: string) => text,
};

async function project() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'xph-dev-')));
	await mkdir(join(root, 'src'));
	await mkdir(join(root, 'dist'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function start(root: string, build: (context: BuildContext) => Promise<void>) {
	const builds: BuildContext[] = [];
	const errors: string[] = [];
	const server = await dev({
		root,
		logger: silent,
		ignore: (file) => inside(join(root, 'dist'), file),
		async build(context) {
			builds.push(context);
			await build(context);
		},
		onError: (message) => void errors.push(message),
	});
	cleanup.unshift(() => server.close());
	return { server, builds, errors };
}

/** Collect the server-sent events a page would receive. */
async function listen(server: DevServer) {
	const events: { event: string; data: unknown }[] = [];
	const controller = new AbortController();
	const response = await fetch(new URL('events', server.client), { signal: controller.signal });
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += value;
				let end;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const chunk = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const event = chunk.match(/^event: (.*)$/m)?.[1];
					const data = chunk.match(/^data: (.*)$/m)?.[1];
					if (event) events.push({ event, data: data && JSON.parse(data) });
				}
			}
		} catch {
			/* Aborted. */
		}
	})();
	cleanup.unshift(async () => controller.abort());
	return events;
}

async function until(test: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (test()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('Timed out');
}

it('builds once, serves the client and batches changes into serialized rebuilds', async () => {
	const root = await project();
	let running = 0;
	let overlapped = false;
	const { server, builds } = await start(root, async () => {
		overlapped ||= running > 0;
		running++;
		await new Promise((resolve) => setTimeout(resolve, 150));
		running--;
	});
	expect(builds).toEqual([
		{ sourceOnly: false, changed: [], client: server.client, watch: expect.any(Function) },
	]);
	expect(server.client).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/client\.js$/);
	const script = await fetch(server.client);
	expect(script.headers.get('access-control-allow-origin')).toBe('*');
	expect(await script.text()).toContain('EventSource');
	const events = await listen(server);
	await Promise.all([
		writeFile(join(root, 'src/A.xph'), '<p>A</p>'),
		writeFile(join(root, 'src/B.xph'), '<p>B</p>'),
	]);
	await until(() => builds.length > 1);
	await server.settled();
	expect(builds[1].sourceOnly).toBe(true);
	expect(builds[1].changed.sort()).toEqual([join(root, 'src/A.xph'), join(root, 'src/B.xph')]);
	await until(() => events.some((e) => e.event === 'reload'));
	await writeFile(join(root, 'src/A.xph'), '<p>A2</p>');
	await until(() => builds.length > 2);
	await writeFile(join(root, 'src/A.xph'), '<p>A3</p>');
	await until(() => builds.length > 3);
	await server.settled();
	expect(overlapped).toBe(false);
});

it('ignores output, dependencies and VCS paths', async () => {
	const root = await project();
	const { server, builds } = await start(root, async () => {});
	await mkdir(join(root, 'node_modules'));
	await writeFile(join(root, 'dist/out.php'), '<?php');
	await writeFile(join(root, 'node_modules/x.js'), '');
	await new Promise((resolve) => setTimeout(resolve, 300));
	await server.settled();
	expect(builds).toHaveLength(1);
	await writeFile(join(root, 'labels.ts'), 'export {};');
	await until(() => builds.length > 1);
	expect(builds[1].sourceOnly).toBe(false);
});

it('swaps styles for stylesheet-only changes and reloads for anything else', async () => {
	const root = await project();
	const { server, builds } = await start(root, async () => {});
	const events = await listen(server);
	await writeFile(join(root, 'src/site.css'), 'p { color: red }');
	await until(() => events.length > 0);
	expect(events.map((e) => e.event)).toEqual(['styles']);
	expect(builds[1].sourceOnly).toBe(false);
	events.length = 0;
	await writeFile(join(root, 'src/site.css'), 'p { color: blue }');
	await writeFile(join(root, 'src/A.xph'), '<p>A</p>');
	await until(() => events.some((e) => e.event === 'reload'));
	expect(events.map((e) => e.event)).toEqual(['ok', 'reload']);
});

it('reports failures to open pages and new connections, then reloads after recovery', async () => {
	const root = await project();
	let fail = false;
	const { server, errors } = await start(root, async () => {
		if (fail) throw new Error('Broken build');
	});
	const events = await listen(server);
	fail = true;
	await writeFile(join(root, 'src/site.css'), 'p {');
	await until(() => events.some((e) => e.event === 'failed'));
	expect(events).toEqual([{ event: 'failed', data: 'Broken build' }]);
	expect(errors).toEqual(['Broken build']);
	const late = await listen(server);
	await until(() => late.length > 0);
	expect(late).toEqual([{ event: 'failed', data: 'Broken build' }]);
	fail = false;
	// A stylesheet-only fix still reloads: the page may be stale from the failed build.
	await writeFile(join(root, 'src/site.css'), 'p {}');
	await until(() => events.some((e) => e.event === 'reload'));
	expect(events.slice(1).map((e) => e.event)).toEqual(['ok', 'reload']);
});

it('swaps changed stylesheets in place and refreshes unhashed same-origin ones', async () => {
	const { client } = await import('../packages/xph-dev/src/client.js');
	type Link = { rel: string; href: string; onload?: () => void; parent?: Link[] };
	const head: Link[] = [];
	const link = (href: string): Link => ({ rel: 'stylesheet', href, parent: head });
	const attribute = (l: Link) => l.href;
	const nodes = (list: Link[]) =>
		list.map((l) =>
			Object.assign(l, {
				getAttribute: () => attribute(l),
				before(other: Link) {
					other.parent = head;
					head.splice(head.indexOf(l), 0, other);
					setTimeout(() => other.onload?.());
				},
				remove: () => head.splice(head.indexOf(l), 1),
			}),
		);
	head.push(
		...nodes([
			link('http://wp.test/assets/old.css'),
			link('http://wp.test/style.css'),
			link('https://fonts.example/font.css'),
		]),
	);
	const html =
		'<link rel="stylesheet" href="/assets/new.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="https://fonts.example/font.css">';
	const listeners: Record<string, (event: { data: string }) => void> = {};
	let reloaded = false;
	const globals = {
		location: {
			href: 'http://wp.test/page',
			origin: 'http://wp.test',
			reload: () => (reloaded = true),
		},
		EventSource: class {
			addEventListener(name: string, listener: (event: { data: string }) => void) {
				listeners[name] = listener;
			}
		},
		fetch: async () => ({ ok: true, text: async () => html }),
		DOMParser: class {
			parseFromString(text: string) {
				const hrefs = [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
				return { querySelectorAll: () => hrefs.map((href) => ({ getAttribute: () => href })) };
			}
		},
		document: {
			querySelectorAll: () => [...head],
			createElement: () => nodes([{ rel: '', href: '' }])[0],
			head: {
				append(l: Link) {
					head.push(l);
					setTimeout(() => l.onload?.());
				},
			},
		},
	};
	const saved = Object.keys(globals).map((key) => [key, Reflect.get(globalThis, key)] as const);
	Object.assign(globalThis, globals);
	try {
		new Function(client.replace('import.meta.url', "'http://127.0.0.1:1/client.js'"))();
		listeners.styles({ data: 'null' });
		await until(() => head.length === 3 && !head.some((l) => l.href.endsWith('old.css')));
		expect(head.map((l) => l.href)).toEqual([
			'http://wp.test/assets/new.css',
			expect.stringMatching(/^http:\/\/wp\.test\/style\.css\?xph-dev=\d+$/),
			'https://fonts.example/font.css',
		]);
		expect(reloaded).toBe(false);
	} finally {
		for (const [key, value] of saved)
			if (value === undefined) Reflect.deleteProperty(globalThis, key);
			else Reflect.set(globalThis, key, value);
	}
});

it('lets the runtime decide between swapping styles and reloading', async () => {
	const root = await project();
	let update: 'styles' | 'reload' | undefined;
	const server = await dev({ root, logger: silent, build: async () => update });
	cleanup.unshift(() => server.close());
	const events = await listen(server);
	update = 'styles';
	await writeFile(join(root, 'src/A.xph'), '<p>A</p><style>p {}</style>');
	await until(() => events.length > 0);
	expect(events.map((e) => e.event)).toEqual(['styles']);
	events.length = 0;
	update = 'reload';
	await writeFile(join(root, 'src/site.css'), 'p {}');
	await until(() => events.some((e) => e.event === 'reload'));
	expect(events.map((e) => e.event)).toEqual(['ok', 'reload']);
});

it('ignores editor backups, swap files and write probes', async () => {
	const root = await project();
	const { server, builds } = await start(root, async () => {});
	for (const name of ['site.css~', '.site.css.swp', '4913', '.#site.css'])
		await writeFile(join(root, 'src', name), '');
	await new Promise((resolve) => setTimeout(resolve, 300));
	await server.settled();
	expect(builds).toHaveLength(1);
});

it('watches only the given paths', async () => {
	const root = await project();
	const builds: BuildContext[] = [];
	const server = await dev({
		root,
		paths: ['src', 'xph.config.ts'],
		logger: silent,
		build: async (context) => void builds.push(context),
	});
	cleanup.unshift(() => server.close());
	await writeFile(join(root, 'labels.ts'), 'export {};');
	await writeFile(join(root, 'dist/out.php'), '<?php');
	await new Promise((resolve) => setTimeout(resolve, 300));
	await server.settled();
	expect(builds).toHaveLength(1);
	await writeFile(join(root, 'xph.config.ts'), 'export default {};');
	await until(() => builds.length > 1);
	await writeFile(join(root, 'src/A.xph'), '<p>A</p>');
	await until(() => builds.length > 2);
	expect(builds.slice(1).map((b) => b.changed)).toEqual([
		[join(root, 'xph.config.ts')],
		[join(root, 'src/A.xph')],
	]);
});

it('watches files a build reads outside its paths until a successful build stops reading them', async () => {
	const root = await project();
	const shared = join(root, 'shared.ts');
	const broken = join(root, 'broken.ts');
	await writeFile(shared, 'export {};');
	await writeFile(broken, 'export {};');
	let read = [shared, join(root, 'src/A.xph'), join(root, 'node_modules/x/index.js')];
	let fail = false;
	const builds: BuildContext[] = [];
	const server = await dev({
		root,
		paths: ['src'],
		logger: silent,
		async build(context) {
			builds.push(context);
			context.watch(read);
			if (fail) throw new Error('Broken build');
		},
	});
	cleanup.unshift(() => server.close());
	const edit = async (file: string) => {
		// Newly watched files take a moment to attach.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const count = builds.length;
		await writeFile(file, `export const at = ${Date.now()};`);
		await until(() => builds.length > count);
		await server.settled();
		return builds.at(-1)!.changed;
	};
	expect(await edit(shared)).toEqual([shared]);
	// A failed build adds what it reported and keeps watching the rest.
	fail = true;
	read = [broken];
	await edit(shared);
	expect(await edit(broken)).toEqual([broken]);
	expect(await edit(shared)).toEqual([shared]);
	// A successful build that no longer reads a file stops watching it.
	fail = false;
	read = [broken];
	await edit(broken);
	const count = builds.length;
	await writeFile(shared, 'export {};');
	await new Promise((resolve) => setTimeout(resolve, 300));
	await server.settled();
	expect(builds).toHaveLength(count);
});
