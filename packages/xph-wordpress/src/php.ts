/** Emit build-time values directly as PHP literals, with no runtime decoding. */
export function php(value: unknown, depth = 0): string {
	if (value === null) return 'null';
	if (typeof value === 'string')
		return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (Array.isArray(value)) return '[' + value.map((value) => php(value, depth)).join(', ') + ']';
	if (typeof value === 'object') {
		const entries = Object.entries(value);
		if (!entries.length) return '[]';
		return (
			'[\n' +
			entries
				.map(
					([key, value]) =>
						'\t'.repeat(depth + 1) + php(key) + ' => ' + php(value, depth + 1) + ',',
				)
				.join('\n') +
			'\n' +
			'\t'.repeat(depth) +
			']'
		);
	}
	throw new Error('Generated PHP values must be serializable constants.');
}
