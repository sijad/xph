import { expect, it } from 'vitest';
import { parseTemplate } from '../packages/xph/src/astro.js';
import { compile } from '../packages/xph/src/compiler.js';

it('preserves UTF-16 spans across frontmatter, attributes, text and expressions', async () => {
	const source = '---\r\nconst label = "😀";\r\n---\r\n<div title={label}>hé😀 {label}</div>';
	const parsed = await parseTemplate(source);
	expect(parsed.diagnostics).toEqual([]);
	const [front, element] = parsed.ast.children;
	expect(front.value).toBe('\r\nconst label = "😀";\r\n');
	expect(source.slice(parsed.start(element), parsed.end(element))).toBe(
		'<div title={label}>hé😀 {label}</div>',
	);
	const attr = element.attributes[0];
	expect(source.slice(parsed.start(attr), parsed.end(attr))).toBe('title={label}');
	expect(attr.value).toBe('label');
	const expression = element.children[1];
	expect(source.slice(parsed.start(expression), parsed.end(expression))).toBe('{label}');
});

it('retains script source including whitespace and Unicode', async () => {
	const body = '\r\nconst message: string = "😀";\r\nconsole.log(message);\r\n';
	const parsed = await parseTemplate(`<script>${body}</script>`);
	expect(parsed.ast.children[0].children[0].value).toBe(body);
});

it('distinguishes empty expression comments from values and preserves their spans', async () => {
	const source = '<p>{/* é😀 */}{ /* leading */ "value" }</p>';
	const parsed = await parseTemplate(source);
	expect(parsed.diagnostics).toEqual([]);
	const [comment, expression] = parsed.ast.children[0].children;
	expect(comment.type).toBe('empty-expression');
	expect(source.slice(parsed.start(comment), parsed.end(comment))).toBe('{/* é😀 */}');
	expect(expression.type).toBe('expression');
	expect(source.slice(parsed.start(expression), parsed.end(expression))).toBe(
		'{ /* leading */ "value" }',
	);
});

it('reports parser errors at their source spans without lowering a recovery AST', async () => {
	const source = '---\nconst x = ;\n---\n<p/>';
	const result = await compile(source);
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			message: 'Unexpected token',
			severity: 'error',
			start: source.indexOf(';'),
			end: source.indexOf(';') + 1,
		}),
	);
	expect(result.php).toBe('');
});
