import type { BlockJson } from './generated/block.js';
export type { BlockJson } from './generated/block.js';
export type BlockSupports = NonNullable<BlockJson['supports']>;
type AttributeKind<T> = [T] extends [string]
	? 'string'
	: [T] extends [number]
		? 'number' | 'integer'
		: [T] extends [boolean]
			? 'boolean'
			: [T] extends [readonly unknown[]]
				? 'array'
				: [T] extends [object]
					? 'object'
					: never;

export interface Attribute<T = unknown> {
	type?: unknown extends T
		? 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
		: AttributeKind<Exclude<T, undefined>>;
	default?: T;
	enum?: (unknown extends T ? string | number | boolean : Extract<T, string | number | boolean>)[];
	role?: 'content' | 'local';
	/** Sidebar label, or false to hide the control. Omit to use the attribute name. */
	control?: string | false;
}

type Managed =
	| 'apiVersion'
	| 'attributes'
	| 'render'
	| 'editorScript'
	| 'script'
	| 'viewScript'
	| 'viewScriptModule'
	| 'style'
	| 'editorStyle'
	| 'viewStyle'
	| 'example'
	| 'variations'
	| 'providesContext';
type Variation = Exclude<NonNullable<BlockJson['variations']>, string>[number];
type RequiredKeys<Props> = {
	[K in keyof Props]-?: undefined extends Props[K] ? never : K;
}[keyof Props];
type Attributes<Props> = { [K in keyof Props]?: Attribute<Props[K]> } & {
	[K in RequiredKeys<Props>]-?: Attribute<Props[K]> & { default: Props[K] };
};
export type BlockMetadata<Props = Record<string, unknown>> = Omit<BlockJson, Managed> & {
	/** Only WordPress Block API v3 is supported. Omit to use 3. */
	apiVersion?: 3;
	name: `${string}/${string}`;
	providesContext?: Record<string, Extract<keyof Props, string>>;
	example?: { attributes?: Partial<Props>; innerBlocks?: unknown[] };
	variations?: (Omit<Variation, 'attributes' | 'isActive' | 'example'> & {
		attributes?: Partial<Props>;
		isActive?: Extract<keyof Props, string>[];
		example?: { attributes?: Partial<Props> };
	})[];
} & (RequiredKeys<Props> extends never
		? { attributes?: Attributes<Props> }
		: { attributes: Attributes<Props> });

interface EditorOptions<Props = Record<string, unknown>> {
	/** Sidebar labels, or false to hide a control. Defaults to the attribute name. */
	controls?: { [K in keyof Props]?: string | false };
}

export interface BlockDefinition<Props = Record<string, unknown>> {
	metadata: BlockMetadata<Props>;
	editor: EditorOptions<Props>;
}

/** Pure build-time metadata; works in ordinary XPH frontmatter. */
export function defineBlock<Props = Record<string, unknown>>(
	metadata: BlockMetadata<Props>,
): BlockDefinition<Props> {
	const attributes: Record<string, Attribute> = {};
	const controls: Record<string, string | false> = {};
	for (const [name, attribute] of Object.entries(metadata.attributes ?? {}) as [
		string,
		Attribute,
	][]) {
		const { control, ...settings } = attribute;
		attributes[name] = settings;
		if (control !== undefined) controls[name] = control;
	}
	return {
		metadata: { ...metadata, attributes } as BlockMetadata<Props>,
		editor: { controls } as EditorOptions<Props>,
	};
}

export type { Config, Result } from './build.js';
export async function build(
	config: import('./build.js').Config = {},
	options?: import('./build.js').Options,
) {
	return (await import('./build.js')).build(config, options);
}
