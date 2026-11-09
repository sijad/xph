# xph-wordpress

A small XPH extension for dynamic WordPress blocks, with live PHP previews in Gutenberg. Requires WordPress 6.5+ and PHP 8.0+. Node.js is only needed during development and builds.

Only WordPress Block API v3 is supported. `apiVersion` is generated as `3`; an explicit value must also be `3`. Metadata and support settings use the checked-in [official block schema](https://schemas.wp.org/trunk/block.json), with typed defaults, enums, variations, context mappings, and sidebar labels based on `Props`. The same schema validates generated metadata at build time, including definitions imported from JavaScript.

```sh
npm install --save-dev xph xph-wordpress
```

Use an ordinary `xph.config.ts`:

```ts
export default { srcDir: 'src', outDir: 'dist' };
```

Create `src/Card.xph`:

```astro
---
import { defineBlock } from 'xph-wordpress';
interface Props { title: string; featured: boolean }
export const block = defineBlock<Props>({
  name: 'example/card', title: 'Card', category: 'widgets',
  attributes: {
    title: { default: 'Hello', control: 'Card title' },
    featured: { default: false, control: 'Featured card' },
  },
  supports: { html: false },
});
---
<article class:list={{ featured: props.featured }}>
  <h2>{props.title}</h2>
</article>
<style>article { padding: 1rem; }</style>
```

```sh
npx xph-wordpress build
npx xph-wordpress dev
npx xph-wordpress check
# Optional config path: xph-wordpress dev path/to/xph.config.ts
```

Include `dist/register.php` from a plugin or theme before WordPress's `init` action. This is the only registration wiring needed. The package generates `block.json`, editor code, PHP rendering, scoped CSS, and frontend script modules. It wraps component output in a `div` with WordPress block wrapper attributes so standard block supports work. It owns its generated files, preserving other plugin/theme files in the output directory. Deploy the generated directory alongside your plugin/theme entrypoint; there is no Node.js runtime dependency.

The [example plugin](../../examples/wordpress-blocks) is ready to build and activate from a local WordPress plugins directory.

## Live preview

The sidebar provides controls inferred from `Props`: text, numbers, toggles, literal union selections, and JSON for objects/arrays. Attribute defaults come from the definition. Required fields must have defaults so a newly inserted block can render immediately; the helper and build both check this. Set `control: 'Label'` in an attribute definition to rename its sidebar label, or `control: false` to hide it. Omitting `control` uses the attribute name. Control settings stay in the editor bundle and are excluded from `block.json`.

The editor uses WordPress's authenticated block renderer, so PHP `Server` data and normal XPH expressions render through the same PHP code used on the frontend. No custom endpoint, JavaScript template renderer, directives, or editor extension is needed. Attribute changes refresh the preview automatically. Arbitrary custom block context beyond WordPress's standard post context is not forwarded by this preview.

Run `dev` against a plugin/theme served by your local WordPress site. The watcher rebuilds when XPH, imported metadata, or config files change. The editor polls a development revision file, refreshes the PHP preview and CSS after successful builds, and displays build errors while retaining the last successful output. Metadata/control changes reload the editor to register the new definition. Save your post before changing block metadata. Restart `dev` after changing the project root or output directory.

Use `build` for deployment: it removes the development revision file and emits editor code without polling. Frontend browser scripts are emitted as script modules; they do not execute inside the PHP editor preview. This preview is intended for inspecting rendered output and editing sidebar attributes.

## Frontmatter and package boundary

`defineBlock` is a pure helper returning metadata. Imports, spreads, constants, and calculations use ordinary XPH frontmatter. The package evaluates exported `block` definitions separately through esbuild, then uses XPH's public build result for props, PHP, dependencies, and assets. Keep build-time definitions deterministic and free of side effects: frontmatter can be evaluated more than once during a build.

Reusable `.xph` components need no block definition. `Props` supplies attribute types; literal unions supply enums. Dynamic attributes are stored in block comments; HTML-sourced attributes are unsupported. Assets and PHP rendering paths are generated. PHP request-time calculations belong in the existing `<script is:server>` and `Server` contract.

This package builds blocks only. Theme/plugin scaffolding, patterns, templates, parts, nested block editing, and custom inline editing syntax are outside its scope. XPH core and its language server remain unchanged. Use the existing XPH editor tooling and `xph.config.ts` for standard language support.

Programmatic builds are available with `import { build } from 'xph-wordpress'`. `build(config, { write: false })` validates without writing; `{ dev: true }` generates development preview polling.

## WordPress themes with Vite

Install `vite`, `xph`, and `xph-wordpress`, then configure:

```ts
import { defineConfig } from 'vite';
import wordpress from 'xph-wordpress/vite';

export default defineConfig({
	plugins: [
		wordpress({
			srcDir: 'src',
			outDir: '../wp-content/themes/my-theme',
			devProxyTarget: 'http://localhost:8001',
		}),
	],
});
```

Paths resolve against Vite's root. `outDir` is required and must be readable by an existing WordPress installation. Run `vite` for development or `vite build` for deployment; no HTML entrypoint is needed. Vite is an optional peer dependency, so existing block CLI projects do not need it.

Set `skipPhpCheck: true` in the `wordpress({ ... })` options to skip `php -l` syntax validation in both development and production builds. Validation is enabled by default.

Place hierarchy templates in `src/theme` (`index.xph`, `archive.xph`, etc.). They compile to PHP with the same relative paths. Other files, including ordinary PHP, `style.css`, images, and fonts, copy unchanged. Supply a WordPress theme header in `style.css`. Place reusable components outside `src/theme`, for example in `src/components`, and blocks anywhere under `src`. Every XPH file in `theme` becomes an entrypoint. PHP helpers execute only when explicitly included.

For a selectable template, export metadata in frontmatter:

```ts
export const template = {
	name: 'Landing Page',
	postTypes: ['page', 'post'],
};
```

`postTypes` defaults to `['page']`. Names must be nonempty and cannot break PHP headers; post types use lowercase letters, numbers, underscores, or hyphens (up to 20 characters). Template entrypoints receive empty props. Use `<script is:server>` and the existing `Server` contract for request data and WordPress rendering hooks.

`functions.php` is generated. To initialize your theme, create `src/theme/functions.xph`:

```html
<script is:server>
	add_action('after_setup_theme', static function () {
	 add_theme_support('title-tag');
	 register_nav_menus(['primary' => 'Primary navigation']);
	});
	return [];
</script>
```

This runs once when WordPress loads the theme, before `after_setup_theme` and `init`. Its rendered markup is discarded. It cannot export custom-template metadata. Copied helpers require explicit includes; compiled server scripts live under `components/theme`, so derive include paths accordingly or use WordPress's `get_theme_file_path()`.

Templates and blocks share an isolated runtime. Template dependency styles are inserted before `</head>` and module scripts before `</body>`, with prepend/append fallbacks for fragments. Include `wp_head()` and `wp_footer()` through PHP server scripts when rendering a full document. Duplicate output names (such as `single.php` and `single.xph`) are rejected.

The builder tracks owned files, removes stale output, and preserves unrelated theme files. It disables Vite's public directory and automatic output clearing. A failed compilation preserves the last successful theme and displays a development overlay; a successful rebuild reloads the page. Gutenberg previews retain development polling. Production output excludes the Vite client and polling files.

Development requests proxy to WordPress with methods, request bodies, cookies, and response status intact. HTML links and redirects use the Vite host, development cookies have local domains/paths, and HTML receives the Vite client. Binary responses pass through unchanged. The development proxy expects uncompressed UTF-8 HTML and buffers it in memory. Use the Vite origin for development only.

See the runnable [theme example](../../examples/wordpress-theme).

Generated PHP omits compiler annotations by default. Set `compactPHP: false` in
configuration or build options to retain them; editor contracts remain detailed.
