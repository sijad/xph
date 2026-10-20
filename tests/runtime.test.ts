import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('validates lists and records by sequential integer keys in iteration order', () => {
	const output = execFileSync(
		'php',
		[
			'-r',
			`require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
$values = [[], ['a', 'b'], [1 => 'a'], [0 => 'a', 2 => 'b'], [1 => 'b', 0 => 'a'], [-1 => 'a'], ['key' => 'a'], ['01' => 'a'], [0 => 'a', 'key' => 'b']];
$result = [];
foreach ($values as $value) {
    $row = [\\Xph\\isList($value)];
    foreach ([['kind' => 'array', 'element' => ['kind' => 'string']], ['kind' => 'object', 'fields' => []]] as $schema) {
        try {
            \\Xph\\validate($value, $schema, 'value');
            $row[] = true;
        } catch (\\InvalidArgumentException $error) {
            $row[] = false;
        }
    }
    $result[] = $row;
}
echo json_encode($result);`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual([
		[true, true, true],
		[true, true, false],
		...Array.from({ length: 7 }, () => [false, false, true]),
	]);
});
