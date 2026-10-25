import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Contract } from 'xph';

let validator: ValidateFunction | undefined;
export function metadataErrors(metadata: unknown): string[] {
	validator ??= new Ajv({ allErrors: true, strict: false }).compile(
		JSON.parse(readFileSync(new URL('../schemas/block.json', import.meta.url), 'utf8')),
	);
	if (validator(metadata)) return [];
	return (validator.errors ?? []).map(
		(error) =>
			`block.json${error.instancePath}: ${error.message}${error.params.additionalProperty ? ' (' + error.params.additionalProperty + ')' : ''}`,
	);
}

/** Validate JavaScript metadata values against the actual XPH Props contract too. */
export function matches(type: Contract, value: unknown): boolean {
	switch (type.kind) {
		case 'literal':
			return value === type.value;
		case 'null':
			return value === null;
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'union':
			return type.types.some((type) => matches(type, value));
		case 'array':
			return Array.isArray(value) && value.every((value) => matches(type.element, value));
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
			const fields = value as Record<string, unknown>;
			return (
				Object.entries(type.fields).every(
					([name, field]) =>
						(field.optional && !(name in fields)) || matches(field.type, fields[name]),
				) && Object.keys(fields).every((name) => name in type.fields)
			);
		}
		default:
			return false;
	}
}
