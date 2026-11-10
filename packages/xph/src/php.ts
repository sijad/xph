import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import type { CompileResult, Config, Diagnostic } from './types.js';
export function run(
	executable: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { shell: false, signal });
		let stdout = '',
			stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
export async function analyzePHP(
	result: Pick<CompileResult, 'php' | 'mappings'>,
	config: Pick<Config, 'php' | 'root'> = {},
	signal?: AbortSignal,
): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];
	const dir = await mkdtemp(join(tmpdir(), 'xph-check-'));
	const file = join(dir, 'component.php');
	const mapped = (line: number, message: string, source: 'php'): Diagnostic => {
		let offset = 0;
		for (const text of result.php.split('\n').slice(0, line - 1)) offset += text.length + 1;
		const mapping = result.mappings.find(
			(m) => offset >= m.generatedStart && offset < m.generatedEnd,
		);
		return {
			message,
			source,
			severity: 'error',
			start: mapping
				? mapping.sourceStart +
					(mapping.generatedEnd - mapping.generatedStart === mapping.sourceEnd - mapping.sourceStart
						? Math.max(0, offset - mapping.generatedStart)
						: 0)
				: 0,
			end: mapping?.sourceEnd ?? 1,
		};
	};
	try {
		await writeFile(file, result.php);
		const exe = config.php ?? 'php';
		try {
			const executable =
				!isAbsolute(exe) && exe.includes('/') ? resolve(config.root ?? '.', exe) : exe;
			const output = await run(executable, ['-l', file], signal);
			if (output.code) {
				const text = output.stderr || output.stdout;
				diagnostics.push(mapped(Number(/on line (\d+)/.exec(text)?.[1] ?? 1), text.trim(), 'php'));
			}
		} catch (e) {
			if (signal?.aborted) throw e;
			diagnostics.push(
				mapped(
					1,
					`Cannot run php (${exe}). Install PHP 8.0+ or configure its executable. ${(e as Error).message}`,
					'php',
				),
			);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return diagnostics;
}

/** PHP 8.3+ can validate multiple files without repeated process startup. */
export async function analyzePHPBatch(
	results: CompileResult[],
	config: Pick<Config, 'php' | 'root'> = {},
): Promise<Diagnostic[][]> {
	if (!results.length) return [];
	if (results.length === 1) return [await analyzePHP(results[0], config)];
	const dir = await mkdtemp(join(tmpdir(), 'xph-check-batch-'));
	try {
		const files = results.map((_, index) => join(dir, `${index}.php`));
		await Promise.all(files.map((file, index) => writeFile(file, results[index].php)));
		const exe = config.php ?? 'php';
		const executable =
			!isAbsolute(exe) && exe.includes('/') ? resolve(config.root ?? '.', exe) : exe;
		try {
			const output = await run(executable, ['-l', ...files]);
			// Older PHP silently checks only the first file. Require confirmation for every file.
			if (
				!output.code &&
				files.every((file) => output.stdout.includes(`No syntax errors detected in ${file}\n`))
			)
				return results.map(() => []);
		} catch {
			// Individual checks below produce the existing executable diagnostics.
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const diagnostics: Diagnostic[][] = [];
	for (const result of results) diagnostics.push(await analyzePHP(result, config));
	return diagnostics;
}
