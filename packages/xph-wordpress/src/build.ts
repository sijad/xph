import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	build as buildXph,
	type Config as XphConfig,
	type BuildOptions,
	type BuildResult,
	type Contract,
} from 'xph';
import { definition } from './metadata.js';
import { editor } from './editor.js';
import { metadataErrors, matches } from './validation.js';
import { php } from './php.js';
import type { Attribute, BlockDefinition } from './index.js';

export type Config = XphConfig;
export interface Options extends BuildOptions {
	dev?: boolean;
}
export interface Result extends BuildResult {
	signatures: Record<string, string>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function attributeType(type: Contract): Attribute['type'] | undefined {
	if (type.kind === 'literal') return typeof type.value as Attribute['type'];
	if (type.kind === 'union') {
		const types = new Set(type.types.map(attributeType));
		return types.size === 1 ? [...types][0] : undefined;
	}
	if (['string', 'number', 'boolean', 'object', 'array'].includes(type.kind))
		return type.kind as Attribute['type'];
}

/** Build only blocks and their imported XPH components. No WordPress-specific core hooks. */
export async function build(config: Config = {}, options: Options = {}): Promise<Result> {
	const result: Result = {
		...(await buildXph(config, { ...options, write: false })),
		signatures: {},
	};
	if (result.diagnostics.some((d) => d.severity === 'error')) return result;
	const root = resolve(config.root ?? '.');
	const src = resolve(root, config.srcDir ?? 'src');
	const id = (file: string) =>
		relative(src, file)
			.split(sep)
			.join('/')
			.replace(/\.xph$/, '');
	const namespace = 'XphWP_' + hash(result.outDir);
	const files = new Map<string, string>();
	const manifest: BuildResult['manifest'] = {};
	const error = (message: string, filename?: string) =>
		result.diagnostics.push({
			message,
			filename,
			severity: 'error',
			source: 'xph',
			start: 0,
			end: 1,
		});
	for (const component of result.components.values())
		for (const asset of component.assets)
			if (asset.type === 'js' || asset.imported)
				files.set('assets/' + asset.filename, asset.content);
	let register = `<?php\nrequire_once __DIR__ . '/runtime.php';\n\\${namespace}\\configure(__DIR__);\nadd_action('init', static function () {\n`;
	for (const [filename, component] of result.components) {
		const key = id(filename);
		files.set(
			'components/' + key + '.php',
			component.php.replaceAll('\\Xph\\', '\\' + namespace + '\\'),
		);
		manifest[key] = {
			file: 'components/' + key + '.php',
			assets: [],
			dependencies: Object.values(component.imports).map((path) =>
				id(resolve(dirname(filename), path)),
			),
		};
		let block: BlockDefinition | undefined;
		try {
			block = await definition(filename);
		} catch (e) {
			error((e as Error).message, filename);
			continue;
		}
		if (!block) continue;
		const metadata = block.metadata;
		if (
			typeof metadata.name !== 'string' ||
			!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(metadata.name)
		) {
			error(
				'Block name must be namespace/name using lowercase letters, numbers and hyphens.',
				filename,
			);
			continue;
		}
		if (!metadata.title || typeof metadata.title !== 'string')
			error('Block title is required.', filename);
		if (metadata.name in result.signatures)
			error('Duplicate block name: ' + metadata.name, filename);
		for (const managed of [
			'render',
			'editorScript',
			'script',
			'viewScript',
			'viewScriptModule',
			'style',
			'editorStyle',
			'viewStyle',
		])
			if (managed in metadata)
				error(managed + ' is generated; define scripts and styles in XPH.', filename);
		if (metadata.apiVersion !== undefined && metadata.apiVersion !== 3)
			error('Only block apiVersion 3 is supported.', filename);
		const attributes: Record<string, Attribute> = {};
		if (component.props.kind === 'object')
			for (const [name, field] of Object.entries(component.props.fields)) {
				const type = attributeType(field.type);
				if (!type) {
					error('Unsupported WordPress attribute type for ' + name, filename);
					continue;
				}
				const settings = metadata.attributes?.[name] ?? {};
				if ('source' in settings)
					error(
						'Dynamic block attributes must be stored in block comments; remove source from ' + name,
						filename,
					);
				if (
					settings.type &&
					settings.type !== type &&
					!(type === 'number' && settings.type === 'integer')
				)
					error('Incompatible attribute type for ' + name, filename);
				attributes[name] = { type, ...settings };
				if (!field.optional && !('default' in settings))
					error(
						'Required attribute ' + name + ' needs a default so new blocks can render.',
						filename,
					);
				if ('default' in settings && !matches(field.type, settings.default))
					error('Default for ' + name + ' does not match Props.', filename);
				if (
					settings.type === 'integer' &&
					settings.default !== undefined &&
					!Number.isInteger(settings.default)
				)
					error('Default for ' + name + ' must be an integer.', filename);
				if (settings.enum?.some((value) => !matches(field.type, value)))
					error('Enum for ' + name + ' does not match Props.', filename);
				if (field.type.kind === 'union' && field.type.types.every((t) => t.kind === 'literal'))
					attributes[name].enum ??= field.type.types.map(
						(t) => (t as { value: string | number | boolean }).value,
					);
				if (
					attributes[name].enum &&
					'default' in settings &&
					!attributes[name].enum!.includes(settings.default as never)
				)
					error('Default for ' + name + ' must be one of its enum values.', filename);
			}
		for (const name of Object.keys(metadata.attributes ?? {}))
			if (!(name in attributes)) error('Attribute ' + name + ' is missing from Props.', filename);
		for (const name of Object.keys(block.editor.controls ?? {}))
			if (!(name in attributes)) error('Control ' + name + ' is missing from Props.', filename);
			else if (
				typeof block.editor.controls?.[name] !== 'string' &&
				block.editor.controls?.[name] !== false
			)
				error('Control ' + name + ' must be a label or false.', filename);
		for (const key of Object.keys(block.editor))
			if (key !== 'controls') error('Unknown editor option: ' + key, filename);
		const directory = 'blocks/' + metadata.name;
		const signature = hash(JSON.stringify({ metadata, attributes, editor: block.editor }));
		result.signatures[metadata.name] = signature;
		const assets = new Map<string, { type: string; content: string }>();
		const seen = new Set<string>();
		function collect(file: string) {
			if (seen.has(file)) return;
			seen.add(file);
			const compiled = result.components.get(file)!;
			for (const path of Object.values(compiled.imports)) collect(resolve(dirname(file), path));
			for (const asset of compiled.assets) {
				if (!asset.imported) assets.set(asset.filename, asset);
			}
		}
		collect(filename);
		files.set(
			directory + '/style.css',
			[...assets.values()]
				.filter((a) => a.type === 'css')
				.map((a) => a.content)
				.join('\n'),
		);
		const scripts = [...assets].filter(([, a]) => a.type === 'js');
		if (scripts.length) {
			files.set(
				directory + '/view.js',
				scripts.map(([name]) => `import ${JSON.stringify('../../../assets/' + name)};`).join('\n') +
					'\n',
			);
		}
		const generated = {
			...metadata,
			apiVersion: 3,
			attributes,
			render: 'file:./render.php',
			editorScript: 'file:./editor.js',
			style: 'file:./style.css',
			...(scripts.length ? { viewScriptModule: 'file:./view.js' } : {}),
		};
		for (const message of metadataErrors(generated)) error(message, filename);
		files.set(directory + '/block.json', json(generated));
		files.set(directory + '/editor.js', editor(block, attributes, options.dev === true, signature));
		files.set(
			directory + '/editor.asset.php',
			`<?php return ${php({ dependencies: ['wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render'], version: hash(files.get(directory + '/editor.js')!) })};\n`,
		);
		files.set(
			directory + '/render.php',
			`<?php\necho '<div ' . get_block_wrapper_attributes() . '>';\necho \\${namespace}\\render(${php(key)}, $attributes);\necho '</div>';\n`,
		);
		register += `  register_block_type(__DIR__ . ${php('/' + directory)});\n`;
	}
	if (!Object.keys(result.signatures).length)
		error('No blocks found. Export const block = defineBlock(...) from an XPH component.');
	register += '});\n';
	files.set('register.php', register);
	files.set('manifest.php', `<?php return ${php({ components: manifest, assets: {} })};\n`);
	files.set(
		'runtime.php',
		(
			await readFile(
				resolve(dirname(fileURLToPath(import.meta.resolve('xph'))), '../runtime/runtime.php'),
				'utf8',
			)
		)
			.replace('namespace Xph;', 'namespace ' + namespace + ';')
			.replaceAll("'xph_", "'" + namespace + '_'),
	);
	if (options.dev)
		files.set(
			'dev.json',
			json({ revision: randomUUID(), signatures: result.signatures, errors: [] }),
		);
	if (options.write === false || result.diagnostics.some((d) => d.severity === 'error'))
		return result;
	// Only remove previously generated files; preserve the surrounding plugin or theme.
	let previous: string[] = [];
	try {
		previous = JSON.parse(await readFile(join(result.outDir, '.xph-wordpress-files.json'), 'utf8'));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
	}
	const inside = (path: string) => {
		const target = resolve(result.outDir, path);
		if (!target.startsWith(result.outDir + sep)) throw new Error('Invalid generated path: ' + path);
		return target;
	};
	for (const [path, content] of files) {
		const target = inside(path);
		await mkdir(dirname(target), { recursive: true });
		const temporary = target + '.' + randomUUID() + '.tmp';
		await writeFile(temporary, content);
		await rename(temporary, target);
	}
	for (const path of previous) if (!files.has(path)) await rm(inside(path), { force: true });
	await writeFile(join(result.outDir, '.xph-wordpress-files.json'), json([...files.keys()]));
	result.manifest = manifest;
	return result;
}
