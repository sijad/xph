# xph

Typed Astro-like components compiled to PHP, CSS, and JavaScript. Build with Node.js;
run on PHP without Node.js in production.

[Website](https://xph.js.org/) · [Syntax reference](https://github.com/sijad/xph/blob/main/docs/reference.md) · [Laravel integration](https://github.com/sijad/xph-laravel)

## Get started

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
npx xph build
```

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
