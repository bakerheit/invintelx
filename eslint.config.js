import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/web/src/components/ui/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Plain .mjs scripts are not covered by typescript-eslint, which is what
    // switches no-undef off for TS. They still run in Node, so say so.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // Not scoped to .tsx: a custom hook is ordinary TypeScript until something
    // renders it, and useDebounced / useTableParams both live in .ts files.
    // Scoping the rules to JSX would leave exactly those unchecked.
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // error, not the plugin's default warn. `eslint .` exits 0 on warnings,
      // so a warn here would be invisible the moment lint becomes a merge gate
      // - and a missing dependency is the bug this whole rule set is for.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    // Taken off the eslintrc-style config rather than flatConfigs, because
    // `.rules` on it is the one shape that has not moved across 6.x.
    rules: jsxA11y.configs.recommended.rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
