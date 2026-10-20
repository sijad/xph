# xph

[Website](https://xph.js.org/)

Typed Astro-like components compiled to PHP 8.0+ and static assets. Deployment needs PHP; Node.js is a development dependency only.

## Develop

Use Node.js 22.12+ and the pinned pnpm version in `package.json`.

```sh
corepack pnpm install
pnpm build
pnpm test
pnpm check
pnpm lint   # Oxlint
pnpm format # Oxfmt
pnpm --filter xph-example-basic build
pnpm --filter xph-example-basic preview
```

Open http://localhost:8080. The resulting `examples/basic/dist/` directory is standalone: copy it to a PHP web server without this workspace or `node_modules`.

## Components

```astro
---
import Card from './Card.xph';
export interface Props { title: string; tooltip?: string }
export interface Server { heading: string }
const label = 'Welcome';
---
<script server lang="php">
return ['heading' => strtoupper($props['title'])];
</script>
<Card title={server.heading}>
  <h2 title={props.tooltip}>{label}: {props.title}</h2>
</Card>
<style>h2 { color: navy }</style>
<script>document.querySelector('h2')?.classList.add('ready');</script>
```

Frontmatter runs at compilation. It supports contracts, imports, helper functions and `const` declarations. Build-time bindings crossing into templates must be serializable values. Native PHP runs once per render, receives associative-array `$props`, and returns an array described by `Server`. Contracts are checked at build time and emitted as PHPDoc annotations; PHP data is not validated against them at runtime. PHP snippets omit `<?php` tags. A component can have multiple server blocks. Each runs once per render in source order with its own local scope and receives `$props`. With multiple blocks, `$server` contains the values returned by earlier blocks. Returned arrays are merged; later keys override earlier keys. All blocks run before template rendering; the combined result is annotated with the `Server` shape.

Supported contracts include primitives, literal values, arrays, nested object records, optional fields, aliases and unions. Objects become associative PHP arrays; arrays become sequential lists. Interfaces can extend interfaces or object type aliases, including multiple bases. Imported types, generic instantiations, mapped and conditional types, and `typeof` field definitions are resolved at build time when they produce supported data shapes. Recursive types, index signatures, tuples, `any` and unresolved types produce diagnostics.

Server can expose PHP closures as required top-level methods, using method signatures or function properties. Arguments and results use the same data contracts as props, with build-time checking and PHPDoc annotations. Methods require fixed, explicitly typed parameters and an explicit return type; optional/rest parameters, optional methods, nested methods and function-valued arguments/results are unsupported. PHP implementations must match the declared contract. Template numbers use floating-point values, so native PHP numeric parameters should accept `int|float` or `float`. Calls run each time their template expression is evaluated; output is escaped normally.

```astro
---
export interface Props { name: string; items: string[] }
export interface Server {
  upper(value: string): string;
  count: (items: string[]) => number;
}
---
<script server lang="php">
return [
    'upper' => static fn(string $value): string => strtoupper($value),
    'count' => static fn(array $items): int => count($items),
];
</script>
<h1>{server.upper(props.name)}</h1>
<p>{server.count(props.items) === 3 ? 'Three items' : 'Another count'}</p>
```

Share contract declarations within frontmatter using `extends` (this shares types; PHP must still return the implementations):

```ts
interface CommonServer {
	upper(value: string): string;
}
export interface Server extends CommonServer {
	heading: string;
}
```

Templates support fragments, imported components, default slots (`<slot>fallback</slot>`), boolean conditions, ternaries and expression-bodied array `.map()` callbacks. Expressions support scalar literals, arrays and explicit object literals, property/index access, optional access, `??`, strict scalar equality, numeric arithmetic/comparisons and string concatenation. Conditions require booleans. `+` requires two strings or two numbers. Calls to declared Server methods are supported. Arbitrary function calls, assignments, coercive equality, string indexing/length and object identity comparisons are rejected. `undefined` remains distinct from `null`; boolean text produces no output. Native PHP controls request-time computation beyond these expressions.

Dynamic text and attributes use UTF-8 `htmlspecialchars` with `ENT_QUOTES | ENT_SUBSTITUTE`. Ordinary nullish/false attributes are omitted; empty strings and zero survive. Boolean HTML attributes use presence; boolean ARIA/data values become `"true"`/`"false"`. `<div set:html={props.html} />` explicitly bypasses escaping. Event-handler attributes are rejected; use a browser script. Browser scripts are type-checked separately and cannot implicitly access `props`, `server` or frontmatter bindings.

Styles are scoped with stable component markers, including keyframe names. Use `<style is:global>` for global CSS. CSS and browser TypeScript are bundled with esbuild into hashed assets. Asset lists include transitive component dependencies and deduplicate by URL. Asset tag placement belongs to the PHP caller.

## Project configuration and CLI

```ts
// xph.config.ts
export default {
	entries: ['src/Page.xph'],
	outDir: 'dist',
	assetBase: '/assets/',
	php: 'php',
};
```

`xph build [config.ts]` resolves dependencies and emits PHP, assets and `manifest.json`. Component names are entry/dependency paths relative to the project root without `.xph`, such as `src/Page`. Imports must resolve to files inside the project root. Cycles are rejected. Failed compilation leaves the previous output in place. The output owns `components/`, `assets/`, `runtime.php`, `manifest.json` and `xph.php`.

`xph dev` watches sources and serializes rebuilds. Run your PHP preview server separately. `xph check` checks TypeScript contracts and invokes PHP syntax checking. Install PHP 8.0+ or configure its executable path. Missing PHP fails the check. PHP syntax diagnostics are mapped back to `.xph`; some errors cover a source line/block rather than an exact token.

```php
<?php
require __DIR__ . '/dist/xph.php';
echo \Xph\render('src/Page', ['title' => 'Hello']);
foreach (\Xph\assets('src/Page') as $asset) {
    // Emit link/script tags wherever your application needs them.
}
```

The public TypeScript APIs are asynchronous `compile(source, options)` and `build(config)`. `compile` returns PHP, IR, assets, imports, contracts, diagnostics, PHP mappings and a mapped virtual TypeScript document. `build` returns a component map, diagnostics, output path and manifest. Source mapping offsets are UTF-16 indices into original `.xph` source, including CRLF. Parsing uses `@astrojs/compiler-rs` through its native Node.js binding and preserves its UTF-16 offsets.

## Astro integration

Use the same compiler from Astro's integration pipeline: The integration registers `.xph` module declarations with Astro. After adding or updating it, run `pnpm exec astro sync` to refresh editor types.

```ts
// astro.config.ts
import { defineConfig } from 'astro/config';
import xph from 'xph/astro';

export default defineConfig({
	integrations: [xph({ entries: ['src/components/Card.xph'] })],
});
```

`astro build` emits the selected components and their dependencies under `dist/xph/`, alongside Astro's existing pages and assets. Load `dist/xph/xph.php` from your PHP application, then call `\Xph\render('src/components/Card', props)`. Astro's resolved build output directory and `base` are respected. Set `directory` to change the `xph` subdirectory or `assetBase` for a CDN.

`astro dev` compiles to `<cacheDir>/xph/`, rebuilds on source changes and serves generated CSS/JS under `<base>/xph/assets/`. PHP remains served by your PHP application. The integration does not import `.xph` into `.astro` pages or translate `.astro` pages to PHP; those require renderer/adapter work beyond this build integration. Astro does not execute native PHP.

## Editor integration

`xph lsp` speaks LSP over stdin/stdout. It provides full-document synchronization, source diagnostics, TypeScript contract completion/hover and component navigation. Template member completions reflect supported operations: object contract fields and array `length`/`map`, without JavaScript scalar methods such as `toFixed` or array methods such as `at`. This also applies to nested fields, optional values and loop items. PHP analysis is debounced, cancelled on edits and version-checked before publication. Unsaved dependency edits recheck open dependents. Project PHP configuration is loaded from `xph.config.ts` when launched through the CLI. PHP completion/navigation, named slots, hydration, React compatibility, dynamic components and WordPress adapters are outside v0.1.

`packages/vscode/` contains a thin VS Code client. Run `pnpm package:vscode` to generate `packages/vscode/xph-vscode-0.1.0.vsix`, install it using **Extensions: Install from VSIX…**, and set `xph.executable` to your CLI path when it is not on PATH. The extension host supplies `vscode`; no VS Code dependency is needed by the compiler or language server.

Neovim 0.11+ is supported through the [Neovim plugin](https://github.com/sijad/xph/tree/main/packages/neovim). Add its runtime directory to `runtimepath` and call `require('xph').setup()` to enable the language server. It includes `.xph` detection and Astro/PHP syntax highlighting.

## Validation and release

`pnpm test:package` packs and installs the artifact, builds the example, removes `node_modules` and renders the output with PHP.

`pnpm test` runs only the new `tests/` suite, including actual PHP rendering, source spans and LSP framing/editor behavior. The reference projects have independent build/test systems and remain unchanged. `pnpm build` produces npm artifacts; `pnpm --filter xph pack` includes the PHP runtime and bundled LSP entrypoint. Publishing is a separate action. npm name availability must be checked before release; registry access was unavailable during initial implementation.

## Publishing to npm

From the workspace root:

```sh
pnpm publish:npm:preview # Check, build, test, and preview package contents
npm login              # Sign in with permission to publish xph
pnpm publish:npm       # Check, build, test, and publish unpublished versions
```

This publishes `xph` publicly to npm. The language server is bundled into `xph` and runs with `xph lsp`; its workspace package is private, so no npm organization is needed. The VS Code extension is packaged separately with `pnpm package:vscode`.

Before each release, update the version in `packages/xph/package.json`, then commit the changes on `main`. Publishing uses pnpm's default Git checks, so the working tree must be clean and the release branch up to date. The preview command does not upload packages or require npm login.
