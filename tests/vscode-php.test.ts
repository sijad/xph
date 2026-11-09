import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedIntelephense } from '../packages/vscode/src/php.js';

it('detects the bundled Intelephense executable without activating its extension', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-intelephense-'));
	try {
		expect(installedIntelephense(undefined)).toBeUndefined();
		expect(installedIntelephense(root)).toBeUndefined();
		const server = join(root, 'node_modules', 'intelephense', 'lib', 'intelephense.js');
		await mkdir(join(root, 'node_modules', 'intelephense', 'lib'), { recursive: true });
		await writeFile(server, '');
		expect(installedIntelephense(root)).toEqual({ command: 'node', args: [server, '--stdio'] });
		expect(installedIntelephense(root, '/custom/node')).toEqual({
			command: '/custom/node',
			args: [server, '--stdio'],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
