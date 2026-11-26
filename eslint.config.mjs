import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-shadow': 'error',
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-param-reassign': ['error', { props: false }],
      'consistent-return': 'off',
      curly: ['error', 'multi-line'],
    },
  },
];
