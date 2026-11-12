import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfig, loadConfig } from '../packages/xph/src/config.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
	const root = await mkdtemp(join(tmpdir(), 'xph-config-'));
	roots.push(root);
	return root;
}
it('finds and loads xph.config.ts, rooted at its directory', async () => {
	const root = await project();
	expect(findConfig(root)).toBeUndefined();
	await writeFile(join(root, 'vite.config.ts'), `export default { plugins: [] };`);
	expect(findConfig(root)).toBeUndefined();
	const file = join(root, 'xph.config.ts');
	await writeFile(file, `export default { srcDir: 'pages' };`);
	expect(findConfig(root)).toBe(file);
	expect(await loadConfig(file)).toEqual({ root, srcDir: 'pages' });
});

it('explains a missing config and keeps its ENOENT code', async () => {
	const root = await project();
	const error = await loadConfig(join(root, 'xph.config.ts')).catch((e) => e);
	expect(error.code).toBe('ENOENT');
	expect(error.message).toContain('No config found at');
	expect(error.message).toContain('Create xph.config.ts');
});
