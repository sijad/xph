# xph

Typed Astro-like components compiled to PHP and static assets. Deployment needs PHP; Node.js is a development dependency only.

For Laravel 13, the [Composer integration](https://github.com/sijad/xph-laravel) adds an
`@xph('resources/component', ['title' => $title])` Blade directive with automatic asset loading.

## Develop

Use Node.js and the pinned pnpm version in `package.json`.

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
<script is:server>
return ['heading' => strtoupper($props['title'])];
</script>
<Card title={server.heading}>
  <h2 title={props.tooltip}>{label}: {props.title}</h2>
</Card>
<style>h2 { color: navy }</style>
<script>document.querySelector('h2')?.classList.add('ready');</script>
```

Frontmatter runs at compilation. It supports contracts, imports, helper functions and `const` declarations. Build-time bindings crossing into templates must be serializable values. Native PHP runs once per render, receives associative-array `$props`, and returns an array described by `Server`. Contracts are checked at build time and emitted as PHPDoc annotations; PHP data is not validated against them at runtime. PHP snippets omit `<?php` tags. A component can have at most one server script, which runs before template rendering and returns the `Server` data.

Supported contracts include primitives, literal values, arrays, nested object records, optional fields, aliases and unions. Objects become associative PHP arrays; arrays become sequential lists. Interfaces can extend local interfaces or object type aliases, including multiple bases. Recursive types, index signatures, `any`, generics and imported contract definitions produce diagnostics.

Server can expose PHP closures as required top-level methods, using method signatures or function properties. Arguments and results use the same data contracts as props, with build-time checking and PHPDoc annotations. Methods require fixed, explicitly typed parameters and an explicit return type; optional/rest parameters, optional methods, nested methods and function-valued arguments/results are unsupported. PHP implementations must match the declared contract. Template numbers use floating-point values, so native PHP numeric parameters should accept `int|float` or `float`. Calls run each time their template expression is evaluated; output is escaped normally.

```astro
---
export interface Props { name: string; items: string[] }
export interface Server {
  upper(value: string): string;
  count: (items: string[]) => number;
}
---
<script is:server>
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

Dynamic HTML element names use string bindings: `const A = 'div';` in frontmatter and `<A>My Div</A>` in the template. String-valued member expressions such as `<props.tag />` also work, including inside template expressions. Dynamic elements support ordinary attributes and scoped styles; void elements omit closing tags. Names must be strings containing a valid HTML tag name.

Templates support fragments, imported components, default slots (`<slot>fallback</slot>`), boolean conditions, ternaries and expression-bodied array `.map()` callbacks. Expressions support scalar literals, arrays and explicit object literals, property/index access, optional access, `??`, strict scalar equality, numeric arithmetic/comparisons and string concatenation. Conditions require booleans. `+` requires two strings or two numbers. Calls to imported or frontmatter functions with build-time arguments are evaluated during compilation and must return serializable values. Calls involving request-time `props`, `server`, or loop variables require declared Server methods. Other function calls, assignments, coercive equality, string indexing/length and object identity comparisons are rejected. `undefined` remains distinct from `null`; boolean text produces no output. Native PHP controls request-time computation beyond these expressions.

Spread attributes (`<div {...props} />`) and component props (`<Card {...props} />`) are supported, including inside template expressions. Attributes and spreads merge in source order; later values override earlier ones. HTML spreads accept objects with scalar attribute values and follow the same escaping and boolean rules as explicit attributes.

Dynamic text and attributes use UTF-8 `htmlspecialchars` with `ENT_QUOTES | ENT_SUBSTITUTE`. Ordinary nullish/false attributes are omitted; empty strings and zero survive. Boolean HTML attributes use presence; boolean ARIA/data values become `"true"`/`"false"`. `<div set:html={props.html} />` explicitly bypasses escaping. Event-handler attributes are rejected; use a browser script. Browser scripts are type-checked separately and cannot implicitly access `props`, `server` or frontmatter bindings.

URL attributes (`href`, `src`, `action`, `formaction`, SVG `href`, and related resource attributes) reject `javascript:`, `vbscript:`, and `data:` schemes after ASCII tab/newline removal and edge-control trimming. Relative URLs, fragments, `mailto:`, `tel:`, and custom application schemes remain supported. Base64 raster images (`png`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `x-icon`) are allowed only in `<img src>`. URL lists such as `srcset` and `ping` are checked too; data URLs in lists are unsupported. Values resembling HTML entities are escaped again, not decoded as URLs. Percent escapes are not decoded into scheme characters, matching browser URL parsing.

All HTML attributes, including spreads, reject invalid names, event handlers, `srcdoc`, and nonscalar values. `class:list` remains the explicit way to flatten nested class values. Dynamic tag names cannot select executable/document-changing or unescaped raw-text elements, including `script`, `style`, `iframe`, `object`, `embed`, `base`, `meta`, `xmp`, and `plaintext`. Use authored browser scripts and styles for those asset contexts. Attribute escaping does not sanitize CSS, constrain custom URL protocol handlers, or validate resource origins; templates and their selected output contexts remain trusted application code.

Migration: replace document or SVG data URLs with hosted resources, use raster image data only in image sources, and use authored markup for restricted dynamic elements. `srcdoc` requires constructing the entire iframe as trusted/sanitized markup through `set:html`. That is an explicit trust boundary, not a sanitizer; never interpolate untrusted HTML into it. Rebuild generated components together with their PHP runtime after upgrading.

Styles are scoped with stable component markers, including keyframe names. Use `<style is:global>` for global CSS. CSS and browser TypeScript are bundled with esbuild into hashed assets. Asset lists include transitive component dependencies and deduplicate by URL. Asset tag placement belongs to the PHP caller.

## Template directives

xph supports the following subset of Astro's template directives in `.xph` components. Unsupported directives produce compiler diagnostics.

| Directive                                                                     | Support                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `set:html`                                                                    | Supported on HTML elements without children. Injects unescaped HTML.                          |
| `<style is:global>`                                                           | Supported. Disables CSS scoping; CSS is still bundled into an asset.                          |
| `class:list`                                                                  | Supported. Flattens nested arrays, includes truthy object keys and combines with `class`.     |
| `set:text`                                                                    | Supported on HTML elements without children. Injects escaped text, like `<div>{value}</div>`. |
| `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only` | Unsupported, including hydration options and client-only fallback slots.                      |
| Custom `client:*` directives                                                  | Unsupported.                                                                                  |
| `server:defer`                                                                | Unsupported.                                                                                  |
| `is:inline`                                                                   | Unsupported on scripts and styles.                                                            |
| `define:vars`                                                                 | Unsupported on scripts and styles.                                                            |
| `is:raw`                                                                      | Unsupported.                                                                                  |

`class:list` accepts strings, numbers, nested arrays and objects whose truthy keys become classes. False, null, undefined and zero values are skipped. It combines with an ordinary `class` attribute and passes the resulting string as `class` to imported components. Values use the supported xph template expression syntax.

`set:text` uses the same escaping and scalar value rules as template text expressions. It cannot be combined with `set:html` or children, and cannot be used on imported components, slots, scripts or styles.

`set:html` bypasses escaping; only pass trusted or sanitized HTML. It does not support imported components, `<Fragment set:html>`, promises or `Response` values. It also cannot be used on `<script>` or `<style>` tags, which are processed separately as assets.

```astro
<div set:html={props.html} />
<div set:text={props.text} />
<style is:global>
  body { margin: 0; }
</style>
```

Adding attributes to scripts or styles does not implicitly make them inline as it does in Astro. Browser scripts and CSS are bundled into external assets; unsupported asset attributes produce diagnostics.

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

Runtime exceptions retain their original class, identity, code, message, stack trace, and previous exception. Generated renderers rethrow the same `Throwable`. Source diagnostics are disabled by default. Enable them explicitly with `\Xph\enableRuntimeDiagnostics()` after loading `xph.php`, or pass `true` as the second argument to `\Xph\configure($directory, true)`. Enabled renderers attach source context in a weak-keyed side table. To log it in a developer error handler:

```php
\Xph\enableRuntimeDiagnostics(); // Developer diagnostics only.
try {
    echo \Xph\render('src/Page', $props);
} catch (\Throwable $error) {
    error_log(\Xph\formatRuntimeError($error));
    throw $error;
}
```

`\Xph\runtimeDiagnostics($error)` returns frames from the innermost failing component/slot outward, including mapped previous exceptions inside framework wrappers. Disabled diagnostics return an empty list and do not construct or retain source-detail tables. Each has `component` and `location` (`start`/`end`: UTF-16 source offsets; `line`/`column`: one-based). An optional `origin` identifies the PHP server-body line where the throwable originated; PHP records an exception's construction location. Template expressions retain their full expression range, including multiline expressions; separate expressions on one line retain separate locations. Attribute expressions retain their ranges too. Component calls, combined spread/class groups, dynamic tag names, and content directives may report the containing element. No `.xph` file or external map is needed at runtime. Older/unmapped throwables return an empty frame list.

Diagnostics are never automatically printed or inserted into HTML. In Laravel, set `XPH_DIAGNOSTICS=true` in `.env` to enable source details in private exception log context; the default is `false`. Builds use project-relative component names; standalone compilation uses a basename, and neither embeds source text or absolute source paths. Keep PHP `display_errors` disabled in production and send detailed exceptions only to private logs. Successful renders perform location-marker assignments without walking stack traces or constructing diagnostic tables. PHP minification is not supported: expression markers survive line movement, but PHP-origin mapping requires preserving the generated server-body line layout. PHP-origin locations use a relative `__LINE__` anchor when generated PHP is embedded in a larger page.

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

## Editor integration

`xph lsp` speaks LSP over stdin/stdout. It provides full-document synchronization, source diagnostics, TypeScript contract completion/hover and component navigation. Template member completions reflect supported operations: object contract fields and array `length`/`map`, without JavaScript scalar methods such as `toFixed` or array methods such as `at`. This also applies to nested fields, optional values and loop items. PHP analysis is debounced, cancelled on edits and version-checked before publication. Unsaved dependency edits recheck open dependents. Project PHP configuration is loaded from `xph.config.ts` when launched through the CLI.

`packages/vscode/` contains a thin VS Code client. Run `pnpm package:vscode` to generate `packages/vscode/xph-vscode-0.1.0.vsix`, install it using **Extensions: Install from VSIX…**, and set `xph.executable` to your CLI path when it is not on PATH. The extension host supplies `vscode`; no VS Code dependency is needed by the compiler or language server.

PHP IntelliSense inside `<script is:server>` is available through an optional PHP language server. Install Intelephense separately (`npm install -g intelephense`), then add this to `xph.config.ts` and restart your editor's xph language server:

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

Neovim 0.11+ is supported through the [Neovim plugin](packages/neovim/README.md). Add its runtime directory to `runtimepath` and call `require('xph').setup()` to enable the language server. It includes `.xph` detection and syntax highlighting.

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
