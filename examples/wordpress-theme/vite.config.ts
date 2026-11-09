import { defineConfig } from 'vite';
import wordpress from 'xph-wordpress/vite';

export default defineConfig({
	plugins: [
		wordpress({
			srcDir: 'src',
			outDir: '../wp-content/themes/xph-example',
			devProxyTarget: 'http://localhost:8001',
		}),
	],
});
