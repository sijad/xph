# WordPress theme example

Run `pnpm install` at the workspace root. Point `outDir` in `vite.config.ts` at a theme directory in an existing WordPress installation, and set `devProxyTarget` to its URL. The defaults assume WordPress serves `examples/wp-content` at http://localhost:8001.

Run `pnpm --filter xph-wordpress-theme-example dev`, activate **XPH Example** in WordPress, then open the Vite URL. Choose **Landing Page** in the page editor to try the custom template. Run `pnpm --filter xph-wordpress-theme-example build` for deployment. PHP and the WordPress installation are required; the deployed theme needs no Node server.
