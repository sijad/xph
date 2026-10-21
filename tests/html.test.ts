import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import {
	nativeTagDefinition,
	nativeAttributeDefinition,
} from '../packages/language-server/src/html.js';

it('loads shared declarations once across tag and attribute lookups', () => {
	const require = createRequire(
		new URL('../packages/language-server/package.json', import.meta.url),
	);
	const ts = require('typescript');
	const read = vi.spyOn(ts.sys, 'readFile');
	try {
		const div = nativeTagDefinition('div');
		expect(div?.uri).toMatch(/\/xph\.d\.ts$/);
		expect(nativeTagDefinition('div')).toEqual(div);
		expect(nativeTagDefinition('p')).not.toBeNull();
		expect(nativeAttributeDefinition('meta', 'charset')?.uri).toBe(div?.uri);
		expect(nativeAttributeDefinition('p', 'class')?.uri).toBe(div?.uri);
		expect(nativeAttributeDefinition('p', 'unknown')).toBeNull();
		expect(nativeAttributeDefinition('meta', 'charset')).not.toBeNull();
		expect(nativeTagDefinition('a', 'svg')).not.toEqual(nativeTagDefinition('a'));
		expect(nativeTagDefinition('unknown-tag')).toBeNull();
		expect(nativeTagDefinition('unknown-tag')).toBeNull();
		expect(nativeTagDefinition('math', 'math')).toBeNull();
		expect(
			read.mock.calls.filter(([filename]) => String(filename).endsWith('/xph.d.ts')),
		).toHaveLength(1);
		expect(read.mock.calls.some(([filename]) => String(filename).endsWith('/lib.dom.d.ts'))).toBe(
			false,
		);
	} finally {
		read.mockRestore();
	}
});

it('ships declarations without TypeScript errors', () => {
	const require = createRequire(
		new URL('../packages/language-server/package.json', import.meta.url),
	);
	const ts = require('typescript');
	const filename = new URL('../packages/language-server/src/xph.d.ts', import.meta.url).pathname;
	const program = ts.createProgram([filename], { noEmit: true, skipLibCheck: false, types: [] });
	expect(program.getSemanticDiagnostics(program.getSourceFile(filename))).toEqual([]);
});

it('types native attribute values while allowing HTML strings and custom token lists', () => {
	const require = createRequire(
		new URL('../packages/language-server/package.json', import.meta.url),
	);
	const ts = require('typescript');
	const filename = new URL('../packages/language-server/src/attribute-test.ts', import.meta.url)
		.pathname;
	const source = `
import type { Elements, HTMLAttributes } from './xph.js';
const input: Elements['input'] = {
  type: 'email', disabled: true, width: 200, maxlength: '100',
  autocomplete: 'section-checkout shipping street-address',
};
const link: Elements['a'] = { href: '/', target: 'my-window', download: true, rel: 'nofollow noopener' };
const button: Elements['button'] = { type: 'submit', disabled: '' };
const global: HTMLAttributes = { contenteditable: 'plaintext-only', 'aria-checked': 'mixed', style: { color: 'red', opacity: 0.5 } };
const text: Elements['textarea'] = { rows: 5, cols: '40' };
// @ts-expect-error Invalid input type.
const invalidInput: Elements['input'] = { type: 'not-an-input-type' };
// @ts-expect-error Button types differ from input types.
const invalidButton: Elements['button'] = { type: 'email' };
// @ts-expect-error Text attributes do not accept objects.
const invalidLink: Elements['a'] = { href: {} };
// @ts-expect-error Numeric attributes do not accept booleans.
const invalidRows: Elements['textarea'] = { rows: false };
// @ts-expect-error Boolean attributes do not accept numbers.
const invalidDisabled: Elements['input'] = { disabled: 1 };
`;
	const options = { noEmit: true, strict: true, types: [] };
	const host = ts.createCompilerHost(options);
	const original = host.getSourceFile;
	host.getSourceFile = (name: string, ...args: any[]) =>
		name === filename
			? ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
			: original(name, ...args);
	const program = ts.createProgram([filename], options, host);
	expect(
		ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic: any) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
	).toEqual([]);
});
