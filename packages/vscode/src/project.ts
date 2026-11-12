import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Config files in lookup order, as xph loads them. */
export const configFiles = ['xph.config.ts'];

/** Find the closest project without inheriting configuration outside the workspace. */
export function findProjectConfig(filename: string, workspaceRoot?: string): string | undefined {
	let directory = dirname(resolve(filename));
	const root = workspaceRoot && resolve(workspaceRoot);
	if (root) {
		const path = relative(root, directory);
		if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return undefined;
	}
	while (true) {
		const candidate = configFiles.map((name) => join(directory, name)).find(existsSync);
		if (candidate) return candidate;
		if (directory === root || dirname(directory) === directory) return undefined;
		directory = dirname(directory);
	}
}
