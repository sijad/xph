import ts from 'typescript';
import type { Contract } from './types.js';
import { hasFunction } from './contracts.js';

/** Resolve imported and computed contracts without executing their modules. */
export function contractResolver(filename: string, code: string) {
	const options: ts.CompilerOptions = {
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		skipLibCheck: true,
		types: [],
	};
	const host = ts.createCompilerHost(options);
	const original = host.getSourceFile;
	host.getSourceFile = (name, version, ...rest) =>
		name === filename
			? ts.createSourceFile(name, code, version, true)
			: original(name, version, ...rest);
	const program = ts.createProgram([filename], options, host);
	const file = program.getSourceFile(filename)!;
	const checker = program.getTypeChecker();
	function convert(type: ts.Type, seen = new Set<ts.Type>()): Contract {
		if (type.flags & ts.TypeFlags.StringLiteral)
			return { kind: 'literal', value: (type as ts.StringLiteralType).value };
		if (type.flags & ts.TypeFlags.NumberLiteral)
			return { kind: 'literal', value: (type as ts.NumberLiteralType).value };
		if (type.flags & ts.TypeFlags.BooleanLiteral)
			return { kind: 'literal', value: checker.typeToString(type) === 'true' };
		if (type.flags & ts.TypeFlags.String) return { kind: 'string' };
		if (type.flags & ts.TypeFlags.Number) return { kind: 'number' };
		if (type.flags & ts.TypeFlags.Boolean) return { kind: 'boolean' };
		if (type.flags & ts.TypeFlags.Null) return { kind: 'null' };
		// Symbol-only brands carry TypeScript metadata, not runtime object fields.
		if (type.isIntersection()) {
			const primitive = type.types.find(
				(part) =>
					!!(
						part.flags &
						(ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)
					),
			);
			const brands = type.types.filter((part) => part !== primitive);
			if (
				primitive &&
				brands.length &&
				brands.every(
					(brand) =>
						!!(brand.flags & ts.TypeFlags.Object) &&
						!brand.getCallSignatures().length &&
						!brand.getConstructSignatures().length &&
						!checker.getIndexInfosOfType(brand).length &&
						brand.getProperties().length > 0 &&
						brand.getProperties().every((property) =>
							property.declarations?.every((declaration) => {
								const name = (declaration as ts.NamedDeclaration).name;
								return (
									name &&
									ts.isComputedPropertyName(name) &&
									!!(checker.getTypeAtLocation(name.expression).flags & ts.TypeFlags.UniqueESSymbol)
								);
							}),
						),
				)
			)
				return convert(primitive, seen);
		}

		if (seen.has(type)) throw new Error('Recursive contracts are unsupported.');
		const next = new Set(seen).add(type);
		if (type.isUnion()) return { kind: 'union', types: type.types.map((t) => convert(t, next)) };
		if (
			checker.isArrayType(type) ||
			(type.getSymbol()?.name === 'ReadonlyArray' && type.flags & ts.TypeFlags.Object)
		) {
			return {
				kind: 'array',
				element: convert(checker.getTypeArguments(type as ts.TypeReference)[0], next),
			};
		}
		if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
			const signatures = type.getCallSignatures();
			if (signatures.length) {
				const signature = signatures[0];
				const declaration = signature.getDeclaration();
				if (
					signatures.length !== 1 ||
					signature.typeParameters?.length ||
					declaration?.parameters.some((p) => p.questionToken || p.dotDotDotToken || p.initializer)
				)
					throw new Error(
						'Server methods require one non-generic signature with required parameters.',
					);
				const callable: Extract<Contract, { kind: 'function' }> = {
					kind: 'function',
					parameters: signature.parameters.map((p) => ({
						name: p.name,
						type: convert(checker.getTypeOfSymbolAtLocation(p, declaration ?? file), next),
					})),
					returns: convert(signature.getReturnType(), next),
				};
				if (callable.parameters.some((p) => hasFunction(p.type)) || hasFunction(callable.returns))
					throw new Error('Server method arguments and results must be data contracts.');
				return callable;
			}
			if (checker.getIndexInfosOfType(type).length || checker.isTupleType(type))
				throw new Error('Index signatures and tuples are unsupported in contracts.');
			const fields: Extract<Contract, { kind: 'object' }>['fields'] = Object.create(null);
			for (const property of type.getProperties()) {
				const optional = !!(property.flags & ts.SymbolFlags.Optional);
				const value = checker.getTypeOfSymbolAtLocation(
					property,
					property.valueDeclaration ?? file,
				);
				if (optional && value.isUnion()) {
					const types = value.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
					fields[property.name] = {
						optional,
						type:
							types.length === 1
								? convert(types[0], next)
								: { kind: 'union', types: types.map((t) => convert(t, next)) },
					};
				} else fields[property.name] = { optional, type: convert(value, next) };
			}
			return { kind: 'object', fields };
		}
		throw new Error(`Unsupported contract: ${checker.typeToString(type)}.`);
	}
	return (name: string): Contract => {
		const declaration = file.statements.find(
			(n) => (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name.text === name,
		);
		if (!declaration) throw new Error(`Unknown contract ${name}.`);
		const errors = program
			.getSemanticDiagnostics(file)
			.filter(
				(d) =>
					d.start !== undefined && d.start >= declaration.getStart() && d.start < declaration.end,
			);
		if (errors.length)
			throw new Error(
				errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
			);
		return convert(checker.getTypeAtLocation(declaration));
	};
}
