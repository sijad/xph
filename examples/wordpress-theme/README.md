# WordPress theme example

Run `pnpm install` at the workspace root. By default `outDir` in `xph.config.ts` is `dist`, which WordPress doesn't load: point it at a theme directory in an existing WordPress installation, such as `../wp-content/themes/xph-example` when WordPress serves `examples/wp-content`.

Run `pnpm --filter xph-wordpress-theme-example dev`, activate **XPH Example** in WordPress, then open the site in your browser (http://localhost:8001 by default). Pages reload when you save, and stylesheet-only changes apply without a reload. Choose **Landing Page** in the page editor to try the custom template; with [ACF](https://www.advancedcustomfields.com/) active, it shows a **Landing Page** field group registered from `src/acf.ts`, whose hero fields `src/components/Hero.xph` renders. Run `pnpm --filter xph-wordpress-theme-example build` for deployment. PHP and the WordPress installation are required; the deployed theme needs no Node server.
