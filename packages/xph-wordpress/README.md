# xph-wordpress

Build WordPress themes and dynamic Gutenberg blocks with XPH. Requires WordPress 6.5+ and PHP 8.0+.

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

interface Props { title: string }

export const block = defineBlock<Props>({
  name: 'example/card',
  title: 'Card',
  category: 'widgets',
  attributes: { title: { default: 'Hello', control: 'Card title' } },
});
---
<h2>{props.title}</h2>
```

Run `npx xph-wordpress dev` while developing and `npx xph-wordpress build` to deploy, then include `dist/register.php` from your plugin or theme. See the [blocks example](https://github.com/sijad/xph/tree/main/examples/wordpress-blocks).

## Themes

Use the same `xph.config.ts`, with `outDir` pointing at a theme directory WordPress loads:

```ts
export default { srcDir: 'src', outDir: '../wp-content/themes/my-theme' };
```

Put templates such as `index.xph` in `src/theme`, next to `style.css` with your theme header and an optional `functions.php`. Keep components outside `src/theme`. When `src/theme` exists the output is a theme; otherwise it is a set of blocks. Run `npx xph-wordpress dev` while developing and `npx xph-wordpress build` to deploy.

A template becomes selectable in the editor when it exports a name:

```ts
export const template = 'Landing Page';
```

See the [theme example](https://github.com/sijad/xph/tree/main/examples/wordpress-theme).

## Development

`xph-wordpress dev` watches `srcDir`, the config file and the files components import, rebuilds after each change and keeps the last good output when a build fails. Browse WordPress at its usual URL: in development, pages load a live reload script that reloads them after a rebuild, applies stylesheet-only changes without a reload, and shows build errors in an overlay. Block previews in the editor refresh on their own. Pass `--skip-php-check` to `build` or `dev` to skip PHP syntax validation.

## ACF fields

Export field groups from `src/acf.ts`; it is picked up automatically when it exists. Each one is registered with [ACF](https://www.advancedcustomfields.com/) and needs a `location`:

```ts
// src/acf.ts
import { createAcfField, createAcfGroup } from 'xph-wordpress/acf';

export const heroField = createAcfField({
	type: 'group',
	name: 'hero',
	label: 'Hero',
	sub_fields: [{ type: 'text', name: 'title', label: 'Title' }],
});

export const landing = createAcfGroup({
	key: 'landing_page',
	title: 'Landing Page',
	fields: [heroField],
	location: [[{ param: 'page_template', operator: '==', value: 'landing.php' }]],
});
```

Load a group by its key in a server script, and type its values with `AcfServer`:

```astro
---
// src/theme/landing.xph
import type { AcfServer } from 'xph-wordpress/acf';
import type { landing } from '../acf';
import Hero from '../components/Hero.xph';

export const template = 'Landing Page';
export interface Server {
	page: AcfServer<typeof landing>;
}
---
<script is:server>
	return ['page' => xph_acf_group('landing_page')];
</script>
<Hero hero={server.page.hero} />
```

```astro
---
// src/components/Hero.xph
import type { AcfValue } from 'xph-wordpress/acf';
import type { heroField } from '../acf';

export interface Props {
	hero: AcfValue<typeof heroField>;
}
---
<h1>{props.hero.title}</h1>
```

`xph_acf_group()` takes a post ID as its second argument, such as `'options'` or `$props['post']`. It is defined in the generated `acf.generated.php`, so the PHP language server knows it and completes group keys once you have built with `outDir` inside your workspace. Add copies of a field with `heroField.withSuffix('2')`.
