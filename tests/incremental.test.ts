import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { build, createBuilder } from '../packages/xph/src/build.js';

it('reuses unchanged components and rechecks importers when child props change', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-incremental-'));
	try {
		await mkdir(join(root, 'src'));
		const child = join(root, 'src/Child.xph');
		const parent = join(root, 'src/Parent.xph');
		const other = join(root, 'src/Other.xph');
		const childSource = (type: string, text: string) =>
			`---\nexport interface Props { title: ${type} }\n---\n<p>${text} {props.title}</p>`;
		await writeFile(child, childSource('string', 'First'));
		await writeFile(parent, '---\nimport Child from "./Child.xph";\n---\n<Child title="Hello" />');
		await writeFile(other, '<p>Other</p>');
		const rebuild = createBuilder({ root });
		const first = await rebuild();
		expect(first.diagnostics).toEqual([]);
		const same = await rebuild();
		for (const file of [child, parent, other])
			expect(same.components.get(file)).toBe(first.components.get(file));
		await writeFile(child, childSource('string', 'Updated'));
		const edited = await rebuild();
		expect(edited.components.get(child)).not.toBe(first.components.get(child));
		expect(edited.components.get(parent)).toBe(first.components.get(parent));
		expect(edited.components.get(other)).toBe(first.components.get(other));
		const output = await readFile(join(root, 'dist/components/Child.php'), 'utf8');
		await writeFile(child, childSource('number', 'Updated'));
		const invalid = await rebuild();
		expect(invalid.components.get(parent)).not.toBe(edited.components.get(parent));
		expect(invalid.diagnostics.some((d) => d.filename === parent && d.severity === 'error')).toBe(
			true,
		);
		expect(await readFile(join(root, 'dist/components/Child.php'), 'utf8')).toBe(output);
		expect((await rebuild()).diagnostics).toEqual(invalid.diagnostics);
		await writeFile(child, childSource('string', 'Recovered'));
		expect((await rebuild()).diagnostics).toEqual([]);
		await rm(child);
		await expect(rebuild()).rejects.toThrow('inside srcDir');
		await writeFile(child, childSource('string', 'Restored'));
		const recovered = await rebuild();
		const clean = await build({ root });
		expect({ ...recovered, compiled: 0 }).toEqual({ ...clean, compiled: 0 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('updates discovery and removes obsolete output and assets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-incremental-'));
	try {
		await mkdir(join(root, 'src'));
		const file = join(root, 'src/A.xph');
		await writeFile(file, '<p>A</p><style>p { color: red }</style>');
		const rebuild = createBuilder({ root });
		const first = await rebuild();
		expect(await readdir(join(root, 'dist/assets'))).not.toEqual([]);
		await writeFile(file, '<p>Updated</p>');
		await writeFile(join(root, 'src/B.xph'), '<p>B</p>');
		const added = await rebuild();
		expect(Object.keys(added.manifest)).toEqual(['A', 'B']);
		expect(await readdir(join(root, 'dist/assets'))).toEqual([]);
		await rm(file);
		const removed = await rebuild();
		expect(Object.keys(removed.manifest)).toEqual(['B']);
		expect(await readdir(join(root, 'dist/components'))).toEqual(['B.php']);
		await writeFile(file, '<p>A</p><style>p { color: red }</style>');
		const restored = await rebuild();
		expect(restored.components.get(file)).not.toBe(first.components.get(file));
		expect({ ...restored, compiled: 0 }).toEqual({ ...(await build({ root })), compiled: 0 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('recompiles only edited styled components and preserves unchanged output files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-incremental-styles-'));
	try {
		await mkdir(join(root, 'src'));
		const a = join(root, 'src/A.xph'),
			b = join(root, 'src/B.xph');
		await writeFile(a, '<p>A</p><style>p { color: red }</style>');
		await writeFile(b, '<p>B</p><style>p { color: blue }</style>');
		const rebuild = createBuilder({ root });
		expect((await rebuild()).compiled).toBe(2);
		const output = join(root, 'dist/components/B.php');
		const before = await stat(output);
		expect((await rebuild({ sourceOnly: true })).compiled).toBe(0);
		await writeFile(a, '<p>Edited</p><style>p { color: green }</style>');
		const changed = await rebuild({ sourceOnly: true });
		expect(changed.compiled).toBe(1);
		expect(changed.diagnostics).toEqual([]);
		expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
		expect((await stat(output)).ino).toBe(before.ino);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('reuses successful PHP checks and validates previously skipped components', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-incremental-php-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/A.xph'), '<p>A</p>');
		await writeFile(join(root, 'src/B.xph'), '<p>B</p>');
		await writeFile(
			join(root, 'php-wrapper'),
			'#!/bin/sh\nprintf x >> "$(dirname "$0")/checks"\nexec php "$@"\n',
		);
		await chmod(join(root, 'php-wrapper'), 0o755);
		const rebuild = createBuilder({ root, php: './php-wrapper' });
		await rebuild({ skipPhpCheck: true });
		expect((await rebuild()).diagnostics).toEqual([]);
		const initialChecks = await readFile(join(root, 'checks'), 'utf8');
		expect(initialChecks).toMatch(/^x+$/);
		await rebuild();
		expect(await readFile(join(root, 'checks'), 'utf8')).toBe(initialChecks);
		await writeFile(join(root, 'src/A.xph'), '<p>Edited</p>');
		await rebuild();
		expect(await readFile(join(root, 'checks'), 'utf8')).toBe(initialChecks + 'x');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
