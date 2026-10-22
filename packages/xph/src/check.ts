import { build } from './build.js';
import type { Config } from './types.js';
export { run, analyzePHP } from './php.js';

export async function check(config: Config) {
	return (await build(config, { write: false })).diagnostics;
}
