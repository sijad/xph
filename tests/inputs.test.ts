import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBuilder } from '../packages/xph/src/build.js';

it('reports imported files and recompiles cached components when one changes', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'xph-inputs-')));
	try {
		await mkdir(join(root, 'src'));
		await mkdir(join(root, 'node_modules/dependency'), { recursive: true });
		await writeFile(
			join(root, 'node_modules/dependency/package.json'),
			'{ "name": "dependency", "main": "index.js" }',
		);
		await writeFile(join(root, 'node_modules/dependency/index.js'), 'exports.suffix = "!";');
		await writeFile(
			join(root, 'node_modules/dependency/index.d.ts'),
			'export declare const suffix: string;',
		);
		await writeFile(join(root, 'labels.ts'), "export const title = 'First';");
		await writeFile(join(root, 'types.ts'), 'export type Size = number;');
		await writeFile(join(root, 'client.ts'), 'export const greet = () => console.log(1);');
		// No <style>: before inputs were tracked, the cached result was reused after labels.ts changed.
		await writeFile(
			join(root, 'src/Page.xph'),
			`---
import { title } from '../labels.ts';
import type { Size } from '../types.ts';
import { suffix } from 'dependency';
const size: Size = 1;
const heading = title + suffix;
---
<h1 data-size={size}>{heading}</h1>
<script>import { greet } from '../client.ts'; greet();</script>`,
		);
		const build = createBuilder({ root });
		const first = await build({ skipPhpCheck: true, write: false });
		expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(first.inputs.sort()).toEqual(
			['client.ts', 'labels.ts', 'types.ts'].map((file) => join(root, file)),
		);
		expect(first.components.get(join(root, 'src/Page.xph'))!.php).toContain('First!');
		await writeFile(join(root, 'labels.ts'), "export const title = 'Second';");
		const second = await build({
			skipPhpCheck: true,
			write: false,
			changed: [join(root, 'labels.ts')],
		});
		expect(second.compiled).toBe(1);
		expect(second.components.get(join(root, 'src/Page.xph'))!.php).toContain('Second!');
		const third = await build({ skipPhpCheck: true, write: false, changed: [] });
		expect(third.compiled).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
