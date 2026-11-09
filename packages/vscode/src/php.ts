import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Reuse the server shipped by the Intelephense extension, over our own stdio transport. */
export function installedIntelephense(extensionPath: string | undefined, runtime = 'node') {
	if (!extensionPath) return undefined;
	const server = join(extensionPath, 'node_modules', 'intelephense', 'lib', 'intelephense.js');
	if (!existsSync(server)) return undefined;
	return { command: runtime, args: [server, '--stdio'] };
}
