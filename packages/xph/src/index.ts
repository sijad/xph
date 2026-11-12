export { compile } from './compiler.js';
export { build, createBuilder } from './build.js';
export { componentImports, type ComponentBinding } from './components.js';
export type { BuildOptions, BuildResult } from './build.js';
export { check, analyzePHP } from './check.js';
export { position, offsetAt, diagnosticLocation, byteOffset, extractPHP } from './source.js';
export type * from './types.js';
