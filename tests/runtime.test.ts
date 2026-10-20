import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('escapes HTML without runtime contract validators', () => {
	const output = execFileSync(
		'php',
		[
			'-r',
			`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
echo json_encode([
    \\Xph\\escape('<script>"&'),
    function_exists('Xph\\\\validate'),
    function_exists('Xph\\\\serverMethods'),
]);`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual(['&lt;script&gt;&quot;&amp;', false, false]);
});
