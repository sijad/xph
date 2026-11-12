# xph-wordpress

Build WordPress themes and dynamic Gutenberg blocks with XPH. Requires WordPress 6.5+ and PHP 8.0+. Node.js is needed only for development and builds.

```sh
npm install --save-dev xph xph-wordpress
```

## Blocks

Create `xph.config.ts`:

```ts
export default { srcDir: 'src', outDir: 'dist' };
```

Create `src/Card.xph`:

```astro
---
import { defineBlock } from 'xph-wordpress';

interface Props { title: string; featured: boolean }

export const block = defineBlock<Props>({
  name: 'example/card',
  title: 'Card',
  category: 'widgets',
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
```

Include `dist/register.php` from your plugin or theme before WordPress's `init` action. Deploy the generated directory with your entrypoint. See the [example plugin](https://github.com/sijad/xph/tree/main/examples/wordpress-blocks).

`Props` supplies attribute types; required attributes need defaults. Set `control: 'Label'` to name a sidebar control or `control: false` to hide it. Only Block API v3 is supported. Reusable components need no block definition.

The editor previews rendered PHP through WordPress's authenticated block renderer. Run `dev` to rebuild on changes and refresh previews; use `build` for deployment. Metadata changes reload the editor, so save your post first. Browser scripts run on the frontend, outside the editor preview.

## Themes with Vite

Install Vite and create `vite.config.ts`:

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

Run `vite` for development or `vite build` for deployment. Paths resolve against Vite's root. `outDir` is required; `devProxyTarget` points to your local WordPress installation.

Place hierarchy templates such as `index.xph` and `archive.xph` in `src/theme`. They compile to matching PHP paths. Other files copy unchanged, including `style.css`, which should contain your WordPress theme header. Keep reusable components outside `src/theme`.

For a selectable template, export metadata in frontmatter:

```ts
export const template = 'Landing Page';

// or

export const template = {
	name: 'Landing Page',
	postTypes: ['page', 'post'], // Defaults to ['page'].
};
```

Initialize your theme in `src/theme/functions.php`. XPH loads it once after its runtime bootstrap, copying it to `theme-functions.php` in the output. Alternatively, use `<script is:server>` in `src/theme/functions.xph`; its rendered markup is discarded. Use one initialization file. Include PHP helpers explicitly.

Use `<script is:server>` and the `Server` contract for request data. Include `wp_head()` and `wp_footer()` when rendering a full document. Template styles and scripts are inserted before `</head>` and `</body>`.

Development proxies WordPress through Vite and reloads after successful builds. Failed builds preserve the last working output. The builder removes stale generated files and preserves unrelated theme files. Duplicate output paths are rejected.

See the [theme example](https://github.com/sijad/xph/tree/main/examples/wordpress-theme).

## Addons

- [acf-generator](https://www.npmjs.com/package/acf-generator) — typed ACF fields and automatic registration.
