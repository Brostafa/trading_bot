
module.exports = {
	apps : [
		{
			name: `trading_bot`,
			script: 'index.mjs',
			env: {
				NODE_ENV: 'production',
			},
			args: ['--colors'],
		}
	]
}
