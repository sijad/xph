import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { LocalGroup } from 'acf-generator';
import { phpValue } from './php.js';

/** Generated registration file, relative to the output directory. */
export const acfFilename = 'acf.generated.php';

// Loads a registered group's values, keyed by field name, as AcfServer types them.
const groupHelper = (keys: string[]) => `if (!function_exists('xph_acf_group')) {
	/** @param ${keys.length ? keys.map((key) => phpValue(key)).join('|') : 'string'} $key */
	function xph_acf_group(string $key, $post_id = false): array {
		$values = [];
		foreach (acf_get_fields($key) ?: [] as $field) $values[$field['name']] = get_field($field['name'], $post_id, true);
		return $values;
	}
}`;

/** Run the fields module and return its exports, plus the files it was built from. */
async function load(
	filename: string,
): Promise<{ exports: Record<string, unknown>; inputs: string[] }> {
	const result = await build({
		entryPoints: [filename],
		bundle: true,
		write: false,
		metafile: true,
		platform: 'node',
		format: 'cjs',
		logLevel: 'silent',
	});
	const module = { exports: {} as Record<string, unknown> };
	// Wrapped like a Node CommonJS module and run with Node's globals, so the module
	// sees what it would under Node; evaluating the fresh bundle each time skips require's cache.
	const run = vm.runInThisContext(
		'(function (exports, require, module, __filename, __dirname) {' +
			result.outputFiles[0].text +
			'\n})',
		{ filename, timeout: 2000 },
	);
	run(module.exports, createRequire(filename), module, filename, dirname(filename));
	return {
		exports: module.exports,
		inputs: Object.keys(result.metafile.inputs)
			.filter((input) => !input.includes('node_modules/'))
			.map((input) => resolve(input)),
	};
}

// The last build of each fields module, reused until one of its inputs changes.
const cache = new Map<string, { stamps: Map<string, string>; groups: Map<string, string> }>();
const stamp = (file: string) => {
	try {
		const stats = statSync(file);
		return stats.mtimeMs + ':' + stats.size;
	} catch {
		return 'missing';
	}
};

/** Files the last build of srcDir/acf.ts read. */
export const acfInputs = (srcDir: string) => [
	...(cache.get(resolve(srcDir, 'acf.ts'))?.stamps.keys() ?? []),
];

const isGroup = (value: unknown): value is LocalGroup<[]> =>
	!!value &&
	typeof value === 'object' &&
	'group' in value &&
	typeof (value as { getCode?: unknown }).getCode === 'function';

/** Register every acf-generator group srcDir/acf.ts exports, each once; undefined without one. */
export async function acfFile(context: {
	root: string;
	srcDir: string;
	/** Compiled components, keyed by filename, whose `xph_acf_group()` keys are checked. */
	components?: Map<string, { php: string }>;
}): Promise<string | undefined> {
	const fields = resolve(context.srcDir, 'acf.ts');
	if (!existsSync(fields)) return undefined;
	const name = relative(context.root, fields);
	let cached = cache.get(fields);
	if (!cached || [...cached.stamps].some(([file, value]) => stamp(file) !== value)) {
		cache.delete(fields);
		const { exports, inputs } = await load(fields);
		const groups = new Map<string, string>();
		for (const value of Object.values(exports)) {
			if (!isGroup(value)) continue;
			const { key, location } = value.group;
			if (groups.has(key)) throw new Error(`ACF group "${key}" is exported twice by ${name}.`);
			if (!location?.length) throw new Error(`ACF group "${key}" in ${name} needs a location.`);
			groups.set(key, (value.getCode() as { registerBody: string }).registerBody);
		}
		cached = { stamps: new Map(inputs.map((input) => [input, stamp(input)])), groups };
		cache.set(fields, cached);
	}
	const { groups } = cached;
	// A literal key is the only link between a server script and the group its Server type names.
	for (const [file, { php }] of context.components ?? [])
		for (const [, , key] of php.matchAll(/\bxph_acf_group\(\s*(['"])([\w-]+)\1/g))
			if (!groups.has(key))
				throw new Error(
					`${relative(context.root, file)}: ACF group "${key}" is not exported by ${name}.`,
				);
	return '<?php\n' + [...groups.values(), groupHelper([...groups.keys()])].join('\n') + '\n';
}
