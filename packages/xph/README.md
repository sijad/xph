# xph

Typed Astro-like components compiled to PHP, CSS, and JavaScript. Build with Node.js;
run on PHP without Node.js in production.

[Website](https://xph.js.org/) · [Syntax reference](https://github.com/sijad/xph/blob/main/docs/reference.md) · [Laravel integration](https://github.com/sijad/xph-laravel)

## Get started

Requires Node.js for builds and PHP 8.0+ for build validation and rendering. CI validates with PHP 8.4.

```sh
npm install --save-dev xph
```

Create `src/Page.xph`:

```astro
---
export interface Props {
  title: string;
}
export interface Server {
  heading: string;
}
---

<script is:server>
    return ['heading' => strtoupper($props['title'])];
</script>

<h1>{server.heading}</h1>
<slot />

<style>
  h1 { color: navy; }
</style>
```

Frontmatter runs at build time. The PHP server block runs on each render, receives
`$props`, and returns the data exposed as `server`. TypeScript contracts check template
usage at build time; they do not validate PHP data at runtime.

Templates support imported components, named slots, conditions, and array `.map()`.
Styles are scoped by default; browser scripts are bundled separately. Dynamic text
and attributes are escaped. Use `set:html` only with trusted or sanitized HTML.

## Build and render

Create `xph.config.ts`:

```ts
export default {
	srcDir: 'src',
	outDir: 'public/dist',
	assetBase: '/dist/assets/',
};
```

```sh
npx xph check
npx xph build
```

`xph check` validates components and generated PHP without writing output. `xph build`
and `xph dev` also validate PHP before replacing output; failures preserve the previous
output. Set `php` in your config to an executable name or path (relative paths resolve
from the project root). To build without PHP validation, use
`xph build [config.ts] --skip-php-check` or `xph dev [config.ts] --skip-php-check`.
Skipping emits a warning; `check` always validates PHP.

Programmatic `build(config, { skipPhpCheck: true })` and `createBuilder(config)`'s
returned function accept the same opt-out. `compile()` never requires PHP.

Successful builds stage and rewrite xph-owned output: `components/`, `assets/`,
`runtime.php`, `manifest.json`, and `xph.php`. Obsolete generated files are removed;
unrelated files in `outDir` are preserved. Replacement is not atomic across the
whole build, so rebuilding a served directory does not guarantee consistent responses.

`xph check` validates components and generated PHP without writing output. `xph build`
and `xph dev` also validate PHP before replacing output; failures preserve the previous
output. Set `php` in your config to an executable name or path (relative paths resolve
from the project root). To build without PHP validation, use
`xph build [config.ts] --skip-php-check` or `xph dev [config.ts] --skip-php-check`.
Skipping emits a warning; `check` always validates PHP.

Programmatic `build(config, { skipPhpCheck: true })` and `createBuilder(config)`'s
returned function accept the same opt-out. `compile()` never requires PHP.

Successful builds stage and rewrite xph-owned output: `components/`, `assets/`,
`runtime.php`, `manifest.json`, and `xph.php`. Obsolete generated files are removed;
unrelated files in `outDir` are preserved. Replacement is not atomic across the
whole build, so rebuilding a served directory does not guarantee consistent responses.

All `.xph` files in `srcDir` compile to PHP. The output includes the runtime, bundled
assets, and a manifest. `assetBase` must match the public URL of the generated assets.

Create `public/index.php`:

```php
<?php
require __DIR__ . '/dist/xph.php';
$renderer = \Xph\renderer(['Page']);
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Hello from xph</title>
    <?php echo $renderer->styles(); ?>
</head>
<body>
    <?php echo $renderer->render('Page', ['title' => 'Hello from xph']); ?>
    <?php echo $renderer->scripts(); ?>
</body>
</html>
```

Register every page component with `renderer()` before calling `styles()` so its CSS
and component dependencies are included. Component names are relative to `srcDir`,
without the `.xph` extension.

```sh
php -S localhost:8080 -t public
```

Open <http://localhost:8080>. During development, run `npx xph dev` in another
terminal to rebuild on changes.

## Editors

- [VS Code](https://github.com/sijad/xph/tree/main/packages/vscode): syntax highlighting,
  diagnostics, completion, and navigation.
- [Neovim](https://github.com/sijad/xph/tree/main/packages/neovim): file detection,
  highlighting, and language-server setup.
- Other LSP clients can launch `xph lsp`. PHP IntelliSense in server blocks requires
  a separately installed PHP language server; see the editor guides.
