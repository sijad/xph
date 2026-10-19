import ts from 'typescript';
import type { Contract } from './types.js';
export const emptyContract: Contract = { kind: 'object', fields: {} };
export function contract(
	node: ts.TypeNode,
	aliases: Map<string, ts.TypeNode | ts.InterfaceDeclaration>,
	seen = new Set<string>(),
): Contract {
	switch (node.kind) {
		case ts.SyntaxKind.StringKeyword:
			return { kind: 'string' };
		case ts.SyntaxKind.NumberKeyword:
			return { kind: 'number' };
		case ts.SyntaxKind.BooleanKeyword:
			return { kind: 'boolean' };
	}
	if (ts.isParenthesizedTypeNode(node)) return contract(node.type, aliases, seen);
	if (ts.isFunctionTypeNode(node)) return functionContract(node, aliases, seen);
	if (ts.isLiteralTypeNode(node)) {
		if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
		if (ts.isStringLiteral(node.literal)) return { kind: 'literal', value: node.literal.text };
		if (ts.isNumericLiteral(node.literal))
			return { kind: 'literal', value: Number(node.literal.text) };
		if (ts.isPrefixUnaryExpression(node.literal) && ts.isNumericLiteral(node.literal.operand))
			return { kind: 'literal', value: -Number(node.literal.operand.text) };
		if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.literal.kind))
			return { kind: 'literal', value: node.literal.kind === ts.SyntaxKind.TrueKeyword };
	}
	if (ts.isArrayTypeNode(node))
		return { kind: 'array', element: contract(node.elementType, aliases, seen) };
	if (ts.isUnionTypeNode(node))
		return { kind: 'union', types: node.types.map((t) => contract(t, aliases, seen)) };
	if (ts.isTypeReferenceNode(node)) {
		const name = node.typeName.getText();
		if (['Array', 'ReadonlyArray'].includes(name) && node.typeArguments?.length === 1)
			return { kind: 'array', element: contract(node.typeArguments[0], aliases, seen) };
		if (seen.has(name)) throw new Error(`Recursive contract ${name} is unsupported.`);
		const ref = aliases.get(name);
		if (!ref) throw new Error(`Unknown contract ${name}.`);
		if (node.typeArguments?.length) throw new Error('Contract generics are unsupported.');
		const next = new Set(seen).add(name);
		return ts.isInterfaceDeclaration(ref)
			? interfaceContract(ref, aliases, next)
			: contract(ref, aliases, next);
	}
	if (ts.isTypeLiteralNode(node)) return objectContract(node.members, aliases, seen);
	throw new Error(`Unsupported contract: ${node.getText()}.`);
}
export function interfaceContract(
	node: ts.InterfaceDeclaration,
	aliases: Map<string, ts.TypeNode | ts.InterfaceDeclaration>,
	seen = new Set<string>([node.name.text]),
): Contract {
	if (node.typeParameters?.length) throw new Error('Contract generics are unsupported.');
	const fields: Extract<Contract, { kind: 'object' }>['fields'] = Object.create(null);
	for (const clause of node.heritageClauses ?? []) {
		for (const base of clause.types) {
			if (!ts.isIdentifier(base.expression) || base.typeArguments?.length)
				throw new Error('Contract bases must be local, non-generic types.');
			const name = base.expression.text;
			if (seen.has(name)) throw new Error(`Recursive contract ${name} is unsupported.`);
			const ref = aliases.get(name);
			if (!ref) throw new Error(`Unknown contract ${name}.`);
			const next = new Set(seen).add(name);
			const schema = ts.isInterfaceDeclaration(ref)
				? interfaceContract(ref, aliases, next)
				: contract(ref, aliases, next);
			if (schema.kind !== 'object') throw new Error('Contract bases must be object contracts.');
			for (const [key, field] of Object.entries(schema.fields)) {
				if (Object.hasOwn(fields, key) && JSON.stringify(fields[key]) !== JSON.stringify(field))
					throw new Error(`Conflicting inherited contract field ${key}.`);
				fields[key] = field;
			}
		}
	}
	const own = objectContract(node.members, aliases, seen);
	if (own.kind === 'object') Object.assign(fields, own.fields);
	return { kind: 'object', fields };
}
export function objectContract(
	members: ts.NodeArray<ts.TypeElement>,
	aliases: Map<string, ts.TypeNode | ts.InterfaceDeclaration>,
	seen = new Set<string>(),
): Contract {
	const fields: Extract<Contract, { kind: 'object' }>['fields'] = Object.create(null);
	for (const member of members) {
		if (
			ts.isMethodSignature(member) &&
			member.name &&
			!ts.isComputedPropertyName(member.name) &&
			!member.questionToken
		) {
			if (Object.hasOwn(fields, (member.name as ts.Identifier).text))
				throw new Error('Server method overloads are unsupported.');
			fields[(member.name as ts.Identifier).text] = {
				type: functionContract(member, aliases, seen),
				optional: false,
			};
			continue;
		}
		if (
			!ts.isPropertySignature(member) ||
			!member.type ||
			!member.name ||
			ts.isComputedPropertyName(member.name)
		)
			throw new Error('Contracts support explicitly typed properties only.');
		fields[(member.name as ts.Identifier).text] = {
			type: contract(member.type, aliases, seen),
			optional: !!member.questionToken,
		};
	}
	return { kind: 'object', fields };
}
export function hasFunction(type: Contract): boolean {
	if (type.kind === 'function') return true;
	if (type.kind === 'array') return hasFunction(type.element);
	if (type.kind === 'union') return type.types.some(hasFunction);
	return (
		type.kind === 'object' && Object.values(type.fields).some((field) => hasFunction(field.type))
	);
}
function functionContract(
	node: ts.FunctionTypeNode | ts.MethodSignature,
	aliases: Map<string, ts.TypeNode | ts.InterfaceDeclaration>,
	seen: Set<string>,
): Contract {
	if (!node.type || node.typeParameters?.length)
		throw new Error('Server methods require explicit return types and cannot be generic.');
	const parameters = node.parameters.map((parameter) => {
		if (
			!ts.isIdentifier(parameter.name) ||
			parameter.name.text === 'this' ||
			!parameter.type ||
			parameter.questionToken ||
			parameter.dotDotDotToken ||
			parameter.initializer
		)
			throw new Error(
				'Server methods require explicitly typed, required parameters without rest arguments.',
			);
		return { name: parameter.name.text, type: contract(parameter.type, aliases, seen) };
	});
	const returns = contract(node.type, aliases, seen);
	if (parameters.some((parameter) => hasFunction(parameter.type)) || hasFunction(returns))
		throw new Error('Server method arguments and results must be data contracts.');
	return { kind: 'function', parameters, returns };
}
export function phpDoc(type: Contract): string {
	switch (type.kind) {
		case 'function':
			return `\\Closure(${type.parameters.map((parameter) => phpDoc(parameter.type)).join(', ')}): ${phpDoc(type.returns)}`;
		case 'number':
			return 'int|float';
		case 'string':
		case 'boolean':
		case 'null':
			return type.kind === 'boolean' ? 'bool' : type.kind;
		case 'literal':
			return JSON.stringify(type.value);
		case 'array':
			return `list<${phpDoc(type.element)}>`;
		case 'union':
			return type.types.map(phpDoc).join('|');
		case 'object':
			return `array{${Object.entries(type.fields)
				.map(([k, v]) => `${JSON.stringify(k)}${v.optional ? '?' : ''}: ${phpDoc(v.type)}`)
				.join(', ')}}`;
	}
}
export function phpLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string')
		return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (Array.isArray(value)) return '[' + value.map(phpLiteral).join(', ') + ']';
	if (typeof value === 'object')
		return (
			'[' +
			Object.entries(value!)
				.map(([k, v]) => `${phpLiteral(k)} => ${phpLiteral(v)}`)
				.join(', ') +
			']'
		);
	throw new Error('Value must be a serializable constant.');
}
