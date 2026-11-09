import { expect, it } from 'vitest';
import { compile, php } from '../packages/xph/src/index.js';

it('validates PHP bodies', () => {
	expect(() => php('<?php echo 1;')).toThrow('without PHP tags');
	expect(() => php(42 as never)).toThrow('string');
});
it('inserts generated statements instead of echoing source', async () => {
	const result = await compile(
		`---
import { php } from 'xph';
const registration = php('echo "registered";');
---
{registration}`,
		{ filename: new URL('../packages/xph/Example.xph', import.meta.url).pathname },
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain('echo "registered";');
});
