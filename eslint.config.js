/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const tseslint = require('typescript-eslint');
const headersPlugin = require('eslint-plugin-headers');

module.exports = tseslint.config(
	tseslint.configs.recommended,
	{
		plugins: {
			headers: headersPlugin,
		},
		files: ['src/**/*.ts'],
		ignores: ['**/*.d.ts', '**/*.test.ts', '**/*.js'],
		rules: {
			'@typescript-eslint/no-use-before-define': 'off',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'headers/header-format': [
				'error',
				{
					source: 'string',
					style: 'jsdoc',
					content: 'Copyright (C) Microsoft Corporation. All rights reserved.',
					blockPrefix: '---------------------------------------------------------\n',
					blockSuffix: '\n *--------------------------------------------------------',
				},
			],
		},
	},
);
