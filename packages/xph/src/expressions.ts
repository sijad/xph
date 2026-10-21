import ts from 'typescript';
import type { Diagnostic, Mapping } from './types.js';
import { phpLiteral } from './contracts.js';
export interface ExpressionInput {
	text: string;
	start: number;
}
export class Expressions {
	code: string;
	mappings: Mapping[] = [];
	diagnostics: Diagnostic[] = [];
	checker: ts.TypeChecker;
	file: ts.SourceFile;
	nodes: ts.Expression[] = [];
	constantNamesUsed = new Set<string>();
	constants: Record<string, unknown> = {};
	foldConstants = false;
	constantLiteral?: (name: string) => string;
	staticValues = new Map<string, { value: unknown }>();
	buildTimeValues = new Map<ts.CallExpression, { value: unknown }>();
	staticValue(n: ts.Expression): { value: unknown } | undefined {
		const known = (value: unknown) => ({ value });
		if (ts.isParenthesizedExpression(n)) return this.staticValue(n.expression);
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return known(n.text);
		if (ts.isNumericLiteral(n)) return known(Number(n.text));
		if (n.kind === ts.SyntaxKind.TrueKeyword) return known(true);
		if (n.kind === ts.SyntaxKind.FalseKeyword) return known(false);
		if (n.kind === ts.SyntaxKind.NullKeyword) return known(null);
		if (ts.isCallExpression(n)) return this.buildTimeValues.get(n);
		if (ts.isIdentifier(n)) {
			const declaration = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
			if (declaration && ts.isParameter(declaration)) return;
			if (n.text === 'undefined') return known(undefined);
			if (Object.hasOwn(this.constants, n.text)) return known(this.constants[n.text]);
			return;
		}
		if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
			const base = this.staticValue(n.expression);
			const key = ts.isPropertyAccessExpression(n)
				? known(n.name.text)
				: this.staticValue(n.argumentExpression);
			if (!base || !key) return;
			if (base.value == null) return ts.isOptionalChain(n) ? known(undefined) : undefined;
			if (typeof base.value !== 'object' || base.value === null) return;
			if (typeof key.value !== 'string' && typeof key.value !== 'number') return;
			const descriptor = Object.getOwnPropertyDescriptor(base.value, key.value);
			if (!descriptor) return known(undefined);
			return 'value' in descriptor ? known(descriptor.value) : undefined;
		}
		if (ts.isArrayLiteralExpression(n)) {
			const items = n.elements.map((item) => this.staticValue(item as ts.Expression));
			return items.every((item) => item !== undefined)
				? known(items.map((item) => item!.value))
				: undefined;
		}
		if (ts.isPrefixUnaryExpression(n)) {
			const value = this.staticValue(n.operand);
			if (!value) return;
			if (n.operator === ts.SyntaxKind.ExclamationToken) return known(!value.value);
			if (typeof value.value !== 'number') return;
			if (n.operator === ts.SyntaxKind.MinusToken) return known(-value.value);
			if (n.operator === ts.SyntaxKind.PlusToken) return known(value.value);
		}
		if (ts.isConditionalExpression(n)) {
			const condition = this.staticValue(n.condition);
			return condition ? this.staticValue(condition.value ? n.whenTrue : n.whenFalse) : undefined;
		}
		if (ts.isBinaryExpression(n)) {
			const left = this.staticValue(n.left);
			if (!left) return;
			const op = n.operatorToken.kind;
			if (op === ts.SyntaxKind.QuestionQuestionToken)
				return left.value == null ? this.staticValue(n.right) : left;
			if (op === ts.SyntaxKind.AmpersandAmpersandToken)
				return left.value ? this.staticValue(n.right) : left;
			if (op === ts.SyntaxKind.BarBarToken) return left.value ? left : this.staticValue(n.right);
			const right = this.staticValue(n.right);
			if (!right) return;
			const a = left.value,
				b = right.value;
			if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return known(a === b);
			if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return known(a !== b);
			if (op === ts.SyntaxKind.PlusToken && typeof a === 'string' && typeof b === 'string')
				return known(a + b);
			if (typeof a !== 'number' || typeof b !== 'number') return;
			switch (op) {
				case ts.SyntaxKind.PlusToken:
					return known(a + b);
				case ts.SyntaxKind.MinusToken:
					return known(a - b);
				case ts.SyntaxKind.AsteriskToken:
					return known(a * b);
				case ts.SyntaxKind.SlashToken:
					return known(a / b);
				case ts.SyntaxKind.AsteriskAsteriskToken:
					return known(a ** b);
				case ts.SyntaxKind.LessThanToken:
					return known(a < b);
				case ts.SyntaxKind.GreaterThanToken:
					return known(a > b);
				case ts.SyntaxKind.LessThanEqualsToken:
					return known(a <= b);
				case ts.SyntaxKind.GreaterThanEqualsToken:
					return known(a >= b);
			}
		}
	}

	buildTimeCalls = new Map<ts.CallExpression, () => string>();
	constructor(
		prefix: string,
		inputs: ExpressionInput[],
		filename: string,
		prefixMappings: Mapping[] = [],
		private serverMethods = new Set<string>(),
	) {
		this.mappings = [...prefixMappings];
		this.code = prefix + '\n';
		for (const [i, input] of inputs.entries()) {
			this.code += `const __xph${i} = (`;
			const start = this.code.length;
			this.code += input.text;
			this.mappings.push({
				generatedStart: start,
				generatedEnd: this.code.length,
				sourceStart: input.start,
				sourceEnd: input.start + input.text.length,
			});
			this.code += ');\n';
		}
		const virtualName = filename + '.tsx';
		const options: ts.CompilerOptions = {
			strict: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			jsx: ts.JsxEmit.Preserve,
			noEmit: true,
			allowJs: true,
			allowImportingTsExtensions: true,
			skipLibCheck: true,
			types: [],
			lib: ['lib.es2022.d.ts'],
		};
		const host = ts.createCompilerHost(options),
			original = host.getSourceFile;
		host.getSourceFile = (name, languageVersion, ...rest) =>
			name === virtualName
				? ts.createSourceFile(name, this.code, languageVersion, true, ts.ScriptKind.TSX)
				: original(name, languageVersion, ...rest);
		const program = ts.createProgram([virtualName], options, host);
		this.file = program.getSourceFile(virtualName)!;
		this.checker = program.getTypeChecker();
		for (const statement of this.file.statements)
			if (ts.isVariableStatement(statement))
				for (const decl of statement.declarationList.declarations)
					if (ts.isIdentifier(decl.name) && /^__xph\d+$/.test(decl.name.text) && decl.initializer)
						this.nodes.push(
							ts.isParenthesizedExpression(decl.initializer)
								? decl.initializer.expression
								: decl.initializer,
						);
		for (const d of ts.getPreEmitDiagnostics(program)) {
			if (d.file !== this.file) continue;
			const m = this.mappings.find(
				(m) => (d.start ?? 0) >= m.generatedStart && (d.start ?? 0) <= m.generatedEnd,
			);
			this.diagnostics.push({
				message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
				severity: 'error',
				source: 'typescript',
				start: m ? m.sourceStart + d.start! - m.generatedStart : 0,
				end: m
					? Math.min(m.sourceEnd, m.sourceStart + d.start! - m.generatedStart + (d.length ?? 1))
					: 0,
			});
		}
	}
	parameterName(node: ts.ParameterDeclaration) {
		return '__xph_local_' + node.getStart();
	}
	range(node: ts.Node) {
		const m = this.mappings.find(
			(m) => node.getStart() >= m.generatedStart && node.getStart() <= m.generatedEnd,
		);
		return {
			start: m ? m.sourceStart + node.getStart() - m.generatedStart : 0,
			end: m ? Math.min(m.sourceEnd, m.sourceStart + node.end - m.generatedStart) : 0,
		};
	}
	fail(node: ts.Node, message: string): never {
		const m = this.mappings.find(
			(m) => node.getStart() >= m.generatedStart && node.getStart() <= m.generatedEnd,
		);
		this.diagnostics.push({
			message,
			severity: 'error',
			source: 'xph',
			start: m ? m.sourceStart + node.getStart() - m.generatedStart : 0,
			end: m ? Math.min(m.sourceEnd, m.sourceStart + node.end - m.generatedStart) : 0,
		});
		throw new Error(message);
	}
	is(node: ts.Node, flag: ts.TypeFlags): boolean {
		const type = this.checker.getTypeAtLocation(node);
		return type.isUnion() ? type.types.every((t) => !!(t.flags & flag)) : !!(type.flags & flag);
	}
	boolean(node: ts.Expression) {
		if (!this.is(node, ts.TypeFlags.BooleanLike))
			this.fail(node, 'Conditions must have boolean type.');
		return this.emit(node);
	}
	scalar(node: ts.Expression) {
		if (
			!this.is(
				node,
				ts.TypeFlags.StringLike |
					ts.TypeFlags.NumberLike |
					ts.TypeFlags.BooleanLike |
					ts.TypeFlags.Null |
					ts.TypeFlags.Undefined,
			)
		)
			this.fail(node, 'Only scalar values can be rendered as text or attributes.');
		return this.emit(node);
	}
	emit(n: ts.Expression): string {
		// Validate every operand before folding, including unreachable branches.
		const code = this.emitDynamic(n);
		if (!this.foldConstants) return code;
		const constant = this.staticValue(n);
		if (!constant) return code;
		if (typeof constant.value === 'number' && !Number.isFinite(constant.value)) return code;
		// Composite constants keep the established serialization diagnostics.
		if (typeof constant.value === 'object' && constant.value !== null) return code;
		const folded =
			constant.value === undefined
				? '\\Xph\\Undefined::value()'
				: typeof constant.value === 'number'
					? Object.is(constant.value, -0)
						? '(-0.0)'
						: `(float) ${phpLiteral(constant.value)}`
					: phpLiteral(constant.value);
		this.staticValues.set(folded, constant);
		return folded;
	}
	private emitDynamic(n: ts.Expression): string {
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isPropertyAccessExpression(n.expression.expression) &&
			ts.isIdentifier(n.expression.expression.expression) &&
			n.expression.expression.expression.text === 'xph' &&
			n.expression.expression.name.text === 'slots' &&
			n.expression.name.text === 'render'
		) {
			const root = this.checker.getSymbolAtLocation(
				n.expression.expression.expression,
			)?.valueDeclaration;
			if (
				!root ||
				!ts.isVariableDeclaration(root) ||
				root.initializer ||
				n.arguments.length < 1 ||
				n.arguments.length > 2 ||
				n.arguments.some(ts.isSpreadElement) ||
				n.typeArguments?.length ||
				ts.isOptionalChain(n) ||
				ts.isOptionalChain(n.expression) ||
				ts.isOptionalChain(n.expression.expression)
			)
				return this.fail(
					n,
					'xph.slots.render requires a slot name and an optional argument array.',
				);
			return (
				'\\Xph\\renderSlot($slot, ' +
				this.emit(n.arguments[0]) +
				', ' +
				(n.arguments[1] ? this.emit(n.arguments[1]) : '[]') +
				')'
			);
		}

		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isIdentifier(n.expression.expression) &&
			n.expression.expression.text === 'server'
		) {
			const root = this.checker.getSymbolAtLocation(n.expression.expression)?.valueDeclaration;
			if (!this.serverMethods.has(n.expression.name.text) || (root && ts.isParameter(root)))
				return this.fail(n, 'Only declared Server methods can be called.');
			if (
				ts.isOptionalChain(n) ||
				ts.isOptionalChain(n.expression) ||
				n.typeArguments?.length ||
				n.arguments.some(ts.isSpreadElement)
			)
				return this.fail(n, 'Server methods require direct calls with positional arguments.');
			const type = this.checker.getTypeAtLocation(n.expression);
			if (!type.getCallSignatures().length)
				return this.fail(n, 'Only declared Server methods can be called.');
			return (
				'(' +
				this.emit(n.expression) +
				')(' +
				n.arguments.map((argument) => this.emit(argument)).join(', ') +
				')'
			);
		}
		if (ts.isParenthesizedExpression(n)) return '(' + this.emit(n.expression) + ')';
		if (ts.isCallExpression(n)) {
			const evaluate = this.buildTimeCalls.get(n);
			if (evaluate) return evaluate();
		}
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return phpLiteral(n.text);
		if (ts.isNumericLiteral(n)) return '(float) ' + n.text;
		if (n.kind === ts.SyntaxKind.TrueKeyword) return 'true';
		if (n.kind === ts.SyntaxKind.FalseKeyword) return 'false';
		if (n.kind === ts.SyntaxKind.NullKeyword) return 'null';
		if (ts.isIdentifier(n)) {
			const symbol = this.checker.getSymbolAtLocation(n),
				declaration = symbol?.valueDeclaration;
			if (declaration && ts.isParameter(declaration)) return '$' + this.parameterName(declaration);
			if (n.text === 'undefined') return '\\Xph\\Undefined::value()';
			if (n.text === 'props' || n.text === 'server') return '$' + n.text;
			this.constantNamesUsed.add(n.text);
			if (this.foldConstants && this.constantLiteral && Object.hasOwn(this.constants, n.text)) {
				try {
					return this.constantLiteral(n.text);
				} catch (e) {
					return this.fail(n, (e as Error).message);
				}
			}
			return '$constants[' + phpLiteral(n.text) + ']';
		}
		if (ts.isPropertyAccessExpression(n)) {
			if (n.name.text === 'length') {
				const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(n.expression));
				if (t.flags & ts.TypeFlags.StringLike)
					this.fail(
						n,
						'String length is unsupported because PHP and JavaScript use different encodings.',
					);
				if (this.checker.isArrayType(t)) return '\\Xph\\length(' + this.emit(n.expression) + ')';
			}
			return (
				'\\Xph\\get(' +
				this.emit(n.expression) +
				', ' +
				phpLiteral(n.name.text) +
				', ' +
				(ts.isOptionalChain(n) ? 'true' : 'false') +
				')'
			);
		}
		if (ts.isElementAccessExpression(n)) {
			if (this.is(n.expression, ts.TypeFlags.StringLike))
				this.fail(n, 'String indexing is unsupported.');
			return (
				'\\Xph\\get(' +
				this.emit(n.expression) +
				', ' +
				this.emit(n.argumentExpression) +
				', ' +
				(ts.isOptionalChain(n) ? 'true' : 'false') +
				')'
			);
		}
		if (ts.isArrayLiteralExpression(n))
			return '[' + n.elements.map((x) => this.emit(x as ts.Expression)).join(', ') + ']';
		if (ts.isObjectLiteralExpression(n))
			return (
				'[' +
				n.properties
					.map((p) => {
						if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name))
							return this.fail(p, 'Only explicit object properties are supported.');
						return phpLiteral((p.name as ts.Identifier).text) + ' => ' + this.emit(p.initializer);
					})
					.join(', ') +
				']'
			);
		if (ts.isPrefixUnaryExpression(n)) {
			if (n.operator === ts.SyntaxKind.ExclamationToken)
				return '(!' + this.boolean(n.operand) + ')';
			if (
				[ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(n.operator) &&
				this.is(n.operand, ts.TypeFlags.NumberLike)
			)
				return (
					'(' + (n.operator === ts.SyntaxKind.MinusToken ? '-' : '+') + this.emit(n.operand) + ')'
				);
			return this.fail(n, 'Unsupported unary operator.');
		}
		if (ts.isConditionalExpression(n))
			return (
				'(' +
				this.boolean(n.condition) +
				' ? ' +
				this.emit(n.whenTrue) +
				' : ' +
				this.emit(n.whenFalse) +
				')'
			);
		if (ts.isBinaryExpression(n)) {
			const op = n.operatorToken.kind;
			let token = n.operatorToken.getText();
			if (op === ts.SyntaxKind.PlusToken) {
				if (this.is(n.left, ts.TypeFlags.StringLike) && this.is(n.right, ts.TypeFlags.StringLike))
					token = '.';
				else if (
					!(this.is(n.left, ts.TypeFlags.NumberLike) && this.is(n.right, ts.TypeFlags.NumberLike))
				)
					return this.fail(n, 'Addition requires two numbers or two strings.');
			} else if (
				[
					ts.SyntaxKind.MinusToken,
					ts.SyntaxKind.AsteriskToken,
					ts.SyntaxKind.SlashToken,
					ts.SyntaxKind.AsteriskAsteriskToken,
					ts.SyntaxKind.LessThanToken,
					ts.SyntaxKind.GreaterThanToken,
					ts.SyntaxKind.LessThanEqualsToken,
					ts.SyntaxKind.GreaterThanEqualsToken,
				].includes(op)
			) {
				if (
					!(this.is(n.left, ts.TypeFlags.NumberLike) && this.is(n.right, ts.TypeFlags.NumberLike))
				)
					return this.fail(n, 'This operator requires numeric operands.');
			} else if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(op)) {
				this.boolean(n.left);
				this.boolean(n.right);
			} else if (
				[
					ts.SyntaxKind.EqualsEqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
				].includes(op)
			) {
				if (
					!this.is(
						n.left,
						ts.TypeFlags.StringLike |
							ts.TypeFlags.NumberLike |
							ts.TypeFlags.BooleanLike |
							ts.TypeFlags.Null |
							ts.TypeFlags.Undefined,
					) ||
					!this.is(
						n.right,
						ts.TypeFlags.StringLike |
							ts.TypeFlags.NumberLike |
							ts.TypeFlags.BooleanLike |
							ts.TypeFlags.Null |
							ts.TypeFlags.Undefined,
					)
				)
					return this.fail(n, 'Strict comparisons support scalar values only.');
				return (
					'\\Xph\\strictEqual(' +
					this.emit(n.left) +
					', ' +
					this.emit(n.right) +
					')' +
					(op === ts.SyntaxKind.ExclamationEqualsEqualsToken ? ' === false' : '')
				);
			} else if (op !== ts.SyntaxKind.QuestionQuestionToken)
				return this.fail(n, 'Unsupported binary operator.');
			if (op === ts.SyntaxKind.QuestionQuestionToken)
				return (
					'\\Xph\\nullish(' + this.emit(n.left) + ', static fn() => ' + this.emit(n.right) + ')'
				);
			if (op === ts.SyntaxKind.SlashToken)
				return '\\Xph\\divide(' + this.emit(n.left) + ', ' + this.emit(n.right) + ')';
			const numeric =
				this.is(n.left, ts.TypeFlags.NumberLike) && this.is(n.right, ts.TypeFlags.NumberLike);
			return (
				'(' +
				(numeric ? '(float) ' : '') +
				this.emit(n.left) +
				' ' +
				token +
				' ' +
				(numeric ? '(float) ' : '') +
				this.emit(n.right) +
				')'
			);
		}
		return this.fail(n, `Unsupported expression: ${ts.SyntaxKind[n.kind]}.`);
	}
}
