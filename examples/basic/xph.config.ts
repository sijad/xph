export default {
	entries: ['src/Page.xph'],
	outDir: 'dist',
	assetBase: '/assets/',
	phpLanguageServer: {
		command: 'intelephense',
		args: ['--stdio'],
		settings: {
			intelephense: {
				environment: { phpVersion: '8.0.0' },
			},
		},
	},
};
