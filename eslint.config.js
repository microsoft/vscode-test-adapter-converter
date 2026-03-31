/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const tseslint = require('typescript-eslint');
const headerPlugin = require('eslint-plugin-header');

module.exports = tseslint.config(
	tseslint.configs.recommended,
	{
		plugins: {
			header: headerPlugin,
		},
		files: ['src/**/*.ts'],
		ignores: ['**/*.d.ts', '**/*.test.ts', '**/*.js'],
		rules: {
			'@typescript-eslint/no-use-before-define': 'off',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'header/header': [
				'error',
				'block',
				'---------------------------------------------------------\n * Copyright (C) Microsoft Corporation. All rights reserved.\n *--------------------------------------------------------',
			],
		},
	},
);
