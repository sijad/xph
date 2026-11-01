import { expect, it } from 'vitest';
import { compile } from '../packages/xph/src/index.js';
import { matches } from '../packages/xph-wordpress/src/validation.js';

it('validates record metadata keys and values', async () => {
	for (const key of ['string', 'number']) {
		const result = await compile(
			`---\nexport interface Props { values: Record<${key}, number> }\n---`,
			{ contractsOnly: true },
		);
		expect(result.diagnostics).toEqual([]);
		expect(matches(result.props, { values: { 1: 2 } })).toBe(true);
		expect(matches(result.props, { values: { 1: 'wrong' } })).toBe(false);
		expect(matches(result.props, { values: { named: 2 } })).toBe(key === 'string');
		expect(matches(result.props, { values: [] })).toBe(false);
	}
});
