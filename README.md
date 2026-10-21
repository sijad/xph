# xph

Typed Astro-like components compiled to PHP 8.0+ and static assets. Deployment needs PHP; Node.js is a development dependency only.

For Laravel 13, the [Composer integration](packages/laravel/README.md) adds an
`@xph('resources/component', ['title' => $title])` Blade directive with automatic asset loading.

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

Frontmatter runs at compilation. It supports contracts, imports, helper functions and `const` declarations. Build-time bindings crossing into templates must be serializable values. Native PHP runs once per render, receives associative-array `$props`, and returns an array described by `Server`. Both prop and server contracts are validated at runtime. PHP snippets omit `<?php` tags. A component can have multiple server blocks. Each runs once per render in source order with its own local scope and receives `$props`. With multiple blocks, `$server` contains the values returned by earlier blocks. Returned arrays are merged; later keys override earlier keys. All blocks run before template rendering, and the combined result is validated against `Server`.

Supported contracts include primitives, literal values, arrays, nested object records, optional fields, aliases and unions. Objects become associative PHP arrays; arrays become sequential lists. Interfaces can extend local interfaces or object type aliases, including multiple bases. Recursive types, index signatures, `any`, generics and imported contract definitions produce diagnostics.

Server can expose PHP closures as required top-level methods, using method signatures or function properties. Arguments and results use the same data contracts as props and are validated at runtime. Methods require fixed, explicitly typed parameters and an explicit return type; optional/rest parameters, optional methods, nested methods and function-valued arguments/results are unsupported. PHP returns actual closures rather than callable names such as `'strtoupper'`. Calls run each time their template expression is evaluated; output is escaped normally.

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

Templates support fragments, imported components, default slots (`<slot>fallback</slot>`), boolean conditions, ternaries and expression-bodied array `.map()` callbacks. Expressions support scalar literals, arrays and explicit object literals, property/index access, optional access, `??`, strict scalar equality, numeric arithmetic/comparisons and string concatenation. Conditions require booleans. `+` requires two strings or two numbers. Calls to imported or frontmatter functions with build-time arguments are evaluated during compilation and must return serializable values. Calls involving request-time `props`, `server`, or loop variables require declared Server methods. Other function calls, assignments, coercive equality, string indexing/length and object identity comparisons are rejected. `undefined` remains distinct from `null`; boolean text produces no output. Native PHP controls request-time computation beyond these expressions.

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

Use the same compiler from Astro's integration pipeline:

```ts
// astro.config.ts
import { defineConfig } from 'astro/config';
import xph from 'xph/astro';

export default defineConfig({
	integrations: [xph()],
});
```

Import `.xph` components directly into `.astro` pages:

```astro
---
import Card from '../components/Card.xph';
---
<html>
  <head><title>Astro + PHP</title></head>
  <body><Card title="Hello"><p>Default slot content</p></Card></body>
</html>
```

`astro build` discovers imported components and compiles them and their dependencies under `dist/xph/`. Pages containing xph components become PHP pages (`index.html` becomes `index.php`), with PHP render calls that run on each request. Ordinary Astro pages stay HTML. Component CSS and JavaScript assets are included automatically and deduplicated per page. Astro layouts, expressions, props, and slot content are evaluated at build time; the xph component's native PHP runs at request time. Props must be JSON-serializable, and only the default slot is supported. Use static Astro output; this integration does not provide an Astro server adapter.

Serve the build output with PHP 8.0+ (for example, `php -S localhost:8080 -t dist`). Configure your production server to serve `index.php` for directory routes. Astro's resolved output directory and `base` are respected. Set `directory` to change the `xph` subdirectory or `assetBase` for a CDN. For components used only by your PHP application, supply additional `entries` and call `\Xph\render()` after loading `dist/xph/xph.php`.

`astro dev` compiles entries to `<cacheDir>/xph/`, rebuilds on source changes, and serves generated CSS/JS under `<base>/xph/assets/`. Imported components emit executable inline PHP between `<?php` and `?>`, without HTML wrappers or escaping. The inline code loads the cached xph runtime and invokes the compiled render closure with its props and default slot. Use a build and a PHP server to preview request-time rendering.

## Editor integration

`xph lsp` speaks LSP over stdin/stdout. It provides full-document synchronization, source diagnostics, TypeScript contract completion/hover and component navigation. Template member completions reflect supported operations: object contract fields and array `length`/`map`, without JavaScript scalar methods such as `toFixed` or array methods such as `at`. This also applies to nested fields, optional values and loop items. PHP analysis is debounced, cancelled on edits and version-checked before publication. Unsaved dependency edits recheck open dependents. Project PHP configuration is loaded from `xph.config.ts` when launched through the CLI. Named slots, hydration, React compatibility, dynamic components and WordPress adapters are outside v0.1.

`packages/vscode/` contains a thin VS Code client. Run `pnpm package:vscode` to generate `packages/vscode/xph-vscode-0.1.0.vsix`, install it using **Extensions: Install from VSIX…**, and set `xph.executable` to your CLI path when it is not on PATH. The extension host supplies `vscode`; no VS Code dependency is needed by the compiler or language server.

PHP IntelliSense inside `<script server lang="php">` is available through an optional PHP language server. Install Intelephense separately (`npm install -g intelephense`), then add this to `xph.config.ts` and restart your editor's xph language server:

```ts
export default {
	entries: ['src/Page.xph'],
	phpLanguageServer: {
		command: 'intelephense',
		args: ['--stdio'],
		settings: {
			intelephense: { environment: { phpVersion: '8.0.0' } },
		},
	},
};
```

The bridge runs in `xph lsp`, so it works in both VS Code and Neovim. It forwards completion, hover, definitions, code actions, whole-component formatting and diagnostics using virtual PHP documents; it does not write generated editor files to disk. Compiler-generated PHPDoc supplies `Props` types, and each server block keeps its own function scope. Edits and diagnostics outside verbatim PHP source spans are filtered out. Completion resolution, automatic imports outside server blocks, rename and signature help are not yet supported. Native `php -l` diagnostics remain enabled. `initializationOptions` can be supplied alongside `settings` for backend-specific initialization. The backend is started lazily; launch errors appear in language-server logs. Restart `xph lsp` after changing backend configuration or if the backend exits.

Neovim 0.11+ is supported through the [Neovim plugin](packages/neovim/README.md). Add its runtime directory to `runtimepath` and call `require('xph').setup()` to enable the language server. It includes `.xph` detection and Astro/PHP syntax highlighting.

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

Astro formatting uses the project's own optional `prettier` (3+) and `prettier-plugin-astro` installations. Add them with `pnpm add -D prettier prettier-plugin-astro`; xph does not install or select their versions for consumers. Without these dependencies, PHP formatting remains available and the rest of the component is preserved.
