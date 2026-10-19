import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProjectConfig } from '../packages/vscode/src/project.js';

it('discovers the closest config and respects workspace boundaries', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-project-'));
	const root = join(directory, 'workspace');
	const project = join(root, 'examples', 'basic');
	await mkdir(join(project, 'src'), { recursive: true });
	try {
		await writeFile(join(directory, 'xph.config.ts'), 'export default {};');
		const filename = join(project, 'src', 'Page.xph');
		expect(findProjectConfig(filename, root)).toBeUndefined();
		await writeFile(join(root, 'xph.config.ts'), 'export default {};');
		expect(findProjectConfig(filename, root)).toBe(join(root, 'xph.config.ts'));
		await writeFile(join(project, 'xph.config.ts'), 'export default {};');
		expect(findProjectConfig(filename, root)).toBe(join(project, 'xph.config.ts'));
		expect(findProjectConfig(join(directory, 'Other.xph'), root)).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
