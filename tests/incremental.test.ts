import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
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
		expect(recovered).toEqual(clean);
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
		expect(restored).toEqual(await build({ root }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
