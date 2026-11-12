import { expect, it } from 'vitest';
import { parseTemplate } from '../packages/xph/src/astro.js';
import { compile } from '../packages/xph/src/compiler.js';

it('preserves UTF-16 spans across frontmatter, attributes, text and expressions', async () => {
	const source = '---\r\nconst label = "😀";\r\n---\r\n<div title={label}>hé😀 {label}</div>';
	const parsed = await parseTemplate(source);
	expect(parsed.diagnostics).toEqual([]);
	const [front, element] = parsed.ast.children;
	expect(front.value).toBe('\r\nconst label = "😀";\r\n');
	expect(source.slice(element.start, element.end)).toBe('<div title={label}>hé😀 {label}</div>');
	const attr = element.attributes[0];
	expect(source.slice(attr.start, attr.end)).toBe('title={label}');
	expect(attr.value).toBe('label');
	const expression = element.children[1];
	expect(source.slice(expression.start, expression.end)).toBe('{label}');
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
	expect(source.slice(comment.start, comment.end)).toBe('{/* é😀 */}');
	expect(expression.type).toBe('expression');
	expect(source.slice(expression.start, expression.end)).toBe('{ /* leading */ "value" }');
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

it('measures template expressions in bounded windows exactly as a full parse would', async () => {
	const { expressionLength } = await import('../packages/xph/src/source.js');
	// The compiler's TypeScript 6 (the workspace root has TypeScript 7, which has no JS API).
	const { createRequire } = await import('node:module');
	const ts = createRequire(new URL('../packages/xph/package.json', import.meta.url))('typescript');
	const full = (text: string) => {
		const prefix = 'const __ = (';
		const file = ts.createSourceFile(
			'e.tsx',
			prefix + text,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		const init = (file.statements[0] as any)?.declarationList?.declarations[0]?.initializer;
		const expression = init && ts.isParenthesizedExpression(init) ? init.expression : init;
		return expression && expression.end - prefix.length;
	};
	const pad = (n: number) => 'x'.repeat(n);
	const tail = '}</p>\n<p>{other}</p>' + '<li>{item}</li>'.repeat(200);
	// Each expression straddles the first window boundaries (256, 1024 characters).
	for (const size of [200, 250, 255, 256, 257, 300, 1020, 1030]) {
		for (const expression of [
			`props.${pad(size)}`,
			`/* ${pad(size)} } */ value`,
			`"${pad(size)} } " + value`,
			`\`${pad(size)} \${a} } \``,
			`cond && <div title="}">${pad(size)} {inner} </div>`,
			`items.map((item) => ({ key: "${pad(size)}" }))`,
			`a ? { b: "${pad(size)}" } : c`,
			`value ${pad(size)}`,
		]) {
			const text = expression + tail;
			expect(expressionLength(text), expression.slice(0, 40)).toBe(full(text));
		}
	}
});
