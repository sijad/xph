/** Trusted PHP statements compiled at a template insertion point. */
export interface PHPCode {
	readonly __xphPHP: true;
	readonly source: string;
}
export function php(source: string): PHPCode {
	if (typeof source !== 'string') throw new Error('php() requires a build-time string.');
	if (source.includes('<?') || source.includes('?>'))
		throw new Error('php() accepts PHP bodies without PHP tags.');
	return Object.freeze({ __xphPHP: true, source });
}
export function isPHPCode(value: unknown): value is PHPCode {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as PHPCode).__xphPHP === true &&
		typeof (value as PHPCode).source === 'string'
	);
}
