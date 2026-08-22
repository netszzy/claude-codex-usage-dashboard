'use strict';

const nodeGlobals = Object.freeze({
  AbortController: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  __dirname: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  module: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  require: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
});

module.exports = [
  {
    ignores: ['.codegraph/**', 'node_modules/**', 'release/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-escape': 'error',
    },
  },
  {
    files: ['dashboard.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
      },
    },
  },
];
