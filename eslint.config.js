// ESLint flat config for the TypeScript sources in packages/ and apps/.
// React: the two hook rules for the desktop renderer (rules-of-hooks, exhaustive-deps).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // Only package and app sources are linted. scripts/*.mjs are the zero-dependency M0 spike tools,
    // covered by `npm run test:scripts`; they are deliberately left out.
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      '**/release/**',
      'scripts/**',
      'fixtures/**',
      'docs/**',
      '.huddle/**',
      '.omc/**',
      '.superpowers/**',
      '.claude/**',
      '*.config.{js,ts,mjs}',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
