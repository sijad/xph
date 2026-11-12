// Remove a package's build output before compiling: `node ../../scripts/clean.mjs [dir]`.
import { rmSync } from 'node:fs';

rmSync(process.argv[2] ?? 'dist', { recursive: true, force: true });
