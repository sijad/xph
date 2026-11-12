import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Publishes every package whose package.json version is not on npm yet, then tags and releases it.
// Order matters: xph-wordpress peers on xph.
const root = resolve(import.meta.dirname, '..');
const packages = ['xph', 'xph-wordpress'];
const dryRun = process.argv.includes('--dry-run');
const run = (command, args, options = {}) =>
	execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const published = (name, version) => {
	try {
		execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' });
		return true;
	} catch (error) {
		if (String(error.stderr).includes('E404')) return false;
		throw error;
	}
};

const dir = await mkdtemp(join(tmpdir(), 'xph-release-'));
try {
	for (const name of packages) {
		const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
		const tag = `${name}@${pkg.version}`;
		if (published(name, pkg.version)) {
			console.log(`${tag} is already published, skipping.`);
			continue;
		}
		console.log(`Releasing ${tag}${dryRun ? ' (dry run)' : ''}`);
		// pnpm pack rewrites workspace: ranges; npm publish handles provenance and trusted publishing.
		run('pnpm', ['--filter', name, 'pack', '--pack-destination', dir]);
		const tarball = join(dir, `${name}-${pkg.version}.tgz`);
		const distTag = pkg.version.includes('-') ? 'next' : 'latest';
		run('npm', [
			'publish',
			tarball,
			'--access',
			'public',
			'--tag',
			distTag,
			...(dryRun ? ['--dry-run'] : ['--provenance']),
		]);
		if (dryRun) continue;
		run('gh', [
			'release',
			'create',
			tag,
			'--target',
			process.env.GITHUB_SHA ?? 'main',
			'--title',
			tag,
			'--generate-notes',
			...(distTag === 'next' ? ['--prerelease'] : []),
		]);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
