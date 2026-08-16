// @ts-check
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    // Build output, dependencies, and the boundary checker's deliberate
    // violation fixtures — those exist to be broken, linting them is noise.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'tools/boundaries/__fixtures__/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // R-C / "Strong TypeScript": `any` hides bugs in money handling.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // The root config itself is CommonJS, because the repo root is not an ES module.
    files: ['eslint.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
