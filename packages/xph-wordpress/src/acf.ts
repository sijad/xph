import type { Field, FieldsToObject, LocalField, LocalGroup } from 'acf-generator';

type AcfField = LocalField<Field> | Field;

/** An acf-generator field, for groups in `src/acf.ts` and for AcfValue. */
export { createField as createAcfField } from 'acf-generator';
/** An acf-generator field group. Every group `src/acf.ts` exports is registered. */
export { createGroup as createAcfGroup } from 'acf-generator';
/** Values of ACF image and file fields, for typing helpers that take them. */
export type { AcfFile, AcfImage } from 'acf-generator';

type List<T> =
	T extends LocalGroup<infer F>
		? F
		: T extends readonly AcfField[]
			? T
			: T extends AcfField
				? readonly [T]
				: readonly [];

/**
 * ACF values keyed by field name, for a field, a list of fields or a group, as
 * `xph_acf_group()` returns them: `page: AcfServer<typeof landing>` in a template's Server.
 */
export type AcfServer<T> = FieldsToObject<Extract<List<T>, readonly AcfField[]>>;

/** The value of one field, for typing a component prop: `hero: AcfValue<typeof heroField>`. */
export type AcfValue<F extends AcfField> = AcfServer<F>[keyof AcfServer<F>];
