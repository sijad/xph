export default {
	srcDir: 'src',
	outDir: 'app/dist',
	assetBase: '/dist/assets/',
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
