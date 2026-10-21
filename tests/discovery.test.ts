import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { build } from '../packages/xph/src/build.js';
import { check } from '../packages/xph/src/check.js';

it('discovers sorted source-relative names, handles additions/deletions and checks unused files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-discovery-'));
	try {
		await mkdir(join(root, 'src/ui'), { recursive: true });
		await writeFile(join(root, 'src/Z.xph'), '<p>Z</p>');
		await writeFile(join(root, 'src/ui/Card.xph'), '<p>Card</p>');
		await writeFile(join(root, 'src/A.xph'), '<p>A</p>');
		expect(Object.keys((await build({ root })).manifest)).toEqual(['A', 'Z', 'ui/Card']);
		await rm(join(root, 'src/Z.xph'));
		await writeFile(join(root, 'src/B.xph'), '<p>B</p>');
		expect(Object.keys((await build({ root })).manifest)).toEqual(['A', 'B', 'ui/Card']);
		const previous = await readFile(join(root, 'dist/manifest.json'), 'utf8');
		await writeFile(join(root, 'src/Unused.xph'), '<p>{unknownVariable}</p>');
		expect((await build({ root })).diagnostics.some((d) => d.severity === 'error')).toBe(true);
		expect((await check({ root })).some((d) => d.filename?.endsWith('Unused.xph'))).toBe(true);
		expect(await readFile(join(root, 'dist/manifest.json'), 'utf8')).toBe(previous);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('excludes output, dependencies, git and symlinks in both build and check', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-discovery-'));
	try {
		for (const directory of ['dist', 'node_modules', '.git', 'hidden']) {
			await mkdir(join(root, directory));
			await writeFile(join(root, directory, 'Bad.xph'), '<p>{unknownVariable}</p>');
		}
		await symlink(join(root, 'hidden'), join(root, 'linked'));
		await symlink(join(root, 'hidden/Bad.xph'), join(root, 'Linked.xph'));
		await rm(join(root, 'hidden'), { recursive: true });
		await writeFile(join(root, 'A.xph'), '<p>A</p>');
		expect(Object.keys((await build({ root, srcDir: '.' })).manifest)).toEqual(['A']);
		await writeFile(join(root, 'dist/Bad.xph'), '<p>{unknownVariable}</p>');
		expect(await check({ root, srcDir: '.' })).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('validates directories, imports and migration, and supports empty sources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-discovery-'));
	try {
		await expect(build({ root })).rejects.toThrow('source directory');
		await expect(build({ root, srcDir: '..' })).rejects.toThrow('inside the project root');
		const legacy = { root, entries: [] };
		await expect(build(legacy)).rejects.toThrow('entries has been removed');
		await mkdir(join(root, 'src'));
		expect((await build({ root })).manifest).toEqual({});
		await writeFile(join(root, 'Outside.xph'), '<p>Outside</p>');
		await writeFile(
			join(root, 'src/A.xph'),
			'---\nimport Outside from "../Outside.xph";\n---\n<Outside />',
		);
		await expect(build({ root })).rejects.toThrow('inside srcDir');
		await rm(join(root, 'src/A.xph'));
		await symlink(join(root, 'Outside.xph'), join(root, 'src/Link.xph'));
		await writeFile(join(root, 'src/A.xph'), '---\nimport Link from "./Link.xph";\n---\n<Link />');
		await expect(build({ root })).rejects.toThrow('inside srcDir');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
