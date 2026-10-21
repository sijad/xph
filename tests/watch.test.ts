import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { watchSources } from '../packages/xph/src/watch.js';

it('watches only xph sources, including nested additions, edits and deletions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-watch-'));
	await mkdir(join(root, 'components'), { recursive: true });
	const watcher = watchSources({ root, srcDir: 'components', outDir: 'components/dist' });
	const events: string[] = [];
	watcher.on('all', (event, path) => {
		if (['add', 'change', 'unlink'].includes(event)) events.push(`${event}:${path}`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			watcher.once('ready', resolve);
			watcher.once('error', reject);
		});
		for (const directory of ['nested', 'dist', 'dist-sources', 'node_modules', '.git'])
			await mkdir(join(root, 'components', directory));
		for (const file of [
			'Outside.xph',
			'components/notes.txt',
			'components/dist/Output.xph',
			'components/node_modules/Dependency.xph',
			'components/.git/Hidden.xph',
		])
			await writeFile(join(root, file), '<p>Ignored</p>');
		const source = join(root, 'components/nested/Card.xph');
		const sibling = join(root, 'components/dist-sources/Card.xph');
		await writeFile(source, '<p>First</p>');
		await writeFile(sibling, '<p>Sibling</p>');
		await expect.poll(() => events).toContain(`add:${source}`);
		await expect.poll(() => events).toContain(`add:${sibling}`);
		await writeFile(source, '<p>Updated</p>');
		await expect.poll(() => events).toContain(`change:${source}`);
		await rm(source);
		await expect.poll(() => events).toContain(`unlink:${source}`);
		expect(events.every((event) => event.endsWith(source) || event.endsWith(sibling))).toBe(true);
	} finally {
		await watcher.close();
		await rm(root, { recursive: true, force: true });
	}
});
