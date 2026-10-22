import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { build, createBuilder } from '../packages/xph/src/build.js';
import { check } from '../packages/xph/src/check.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';

it('preserves output on PHP errors and recovers, replaces owned output, and respects executable paths', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-validation-'));
	try {
		await mkdir(join(root, 'src'));
		const file = join(root, 'src/Page.xph');
		await writeFile(file, '<p>Before</p>');
		const rebuild = createBuilder({ root });
		expect((await rebuild()).diagnostics).toEqual([]);
		const output = join(root, 'dist/components/Page.php');
		const before = await readFile(output, 'utf8');
		await writeFile(join(root, 'dist/keep.txt'), 'keep');
		await writeFile(join(root, 'dist/components/obsolete.php'), 'obsolete');
		await writeFile(file, '<script is:server>return [;</script><p>Broken</p>');
		const invalid = await rebuild();
		expect(
			invalid.diagnostics.some(
				(d) => d.source === 'php' && d.filename === file && d.severity === 'error',
			),
		).toBe(true);
		expect(await readFile(output, 'utf8')).toBe(before);
		await writeFile(file, '<p>After</p>');
		expect(
			(await build({ root, php: './missing-php' })).diagnostics.some((d) =>
				d.message.includes('Cannot run php'),
			),
		).toBe(true);
		expect(await readFile(output, 'utf8')).toBe(before);
		await writeFile(join(root, 'php-wrapper'), '#!/bin/sh\nexec php "$@"\n');
		await chmod(join(root, 'php-wrapper'), 0o755);
		expect((await build({ root, php: './php-wrapper' })).diagnostics).toEqual([]);
		expect((await rebuild()).diagnostics).toEqual([]);
		expect(await readFile(output, 'utf8')).not.toBe(before);
		expect(await readdir(join(root, 'dist/components'))).toEqual(['Page.php']);
		expect(await readFile(join(root, 'dist/keep.txt'), 'utf8')).toBe('keep');
		const skipped = await build({ root, php: './missing-php' }, { skipPhpCheck: true });
		expect(skipped.diagnostics.map((d) => d.severity)).toEqual(['warning']);
		expect((await check({ root, php: './missing-php' })).some((d) => d.severity === 'error')).toBe(
			true,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('parses CLI skip flags with default and explicit configs and rejects unsupported combinations', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-cli-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/Page.xph'), '<p>Hello</p>');
		await writeFile(
			join(root, 'xph.config.ts'),
			`export default { root: ${JSON.stringify(root)}, php: './missing-php' };`,
		);
		const cli = join(root, 'cli.mjs');
		await bundle({
			entryPoints: ['packages/xph/src/cli.ts'],
			outfile: cli,
			bundle: true,
			platform: 'node',
			format: 'esm',
			packages: 'external',
			external: ['./lsp.js'],
		});
		// Keep the bundled CLI next to dependencies and runtime resources.
		const bundled = await readFile(cli, 'utf8');
		const localCli = join(
			process.cwd(),
			'packages/xph/validation-cli-' + root.split('/').pop() + '.mjs',
		);
		await writeFile(
			localCli,
			bundled.replaceAll('../runtime/runtime.php', './runtime/runtime.php'),
		);
		try {
			const invoke = async (args: string[]) => {
				try {
					const result = await promisify(execFile)(process.execPath, [localCli, ...args], {
						cwd: root,
					});
					return { ...result, code: 0 };
				} catch (error) {
					return error as { code: number; stderr: string };
				}
			};
			const config = join(root, 'xph.config.ts');
			expect((await invoke(['build', '--skip-php-check'])).code).toBe(0);
			expect((await invoke(['build', config])).code).toBe(1);
			expect((await invoke(['build', config, '--skip-php-check'])).code).toBe(0);
			expect((await invoke(['build', '--skip-php-check', config])).code).toBe(0);
			expect((await invoke(['check', config, '--skip-php-check'])).stderr).toContain('Usage:');
			expect((await invoke(['build', config, '--unknown'])).code).toBe(1);
		} finally {
			await rm(localCli, { force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
