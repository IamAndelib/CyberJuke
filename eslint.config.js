// ESLint 9 flat config. `npm run lint` fails on errors only; warnings are reported but allowed.
//
// TypeScript 7 (the native compiler used by `npm run typecheck`) has no JavaScript API, and
// typescript-eslint 8 needs one. TypeScript's own side-by-side package, @typescript/typescript6,
// provides the TS 6 API, so the resolve hook below sends typescript-eslint's `typescript` imports
// there. Everything else (tsc, vite, vitest) keeps using TypeScript 7. package.json pins the
// `typescript` peer range with an override so npm accepts the pair. Remove all of this once
// typescript-eslint supports TS 7 (https://github.com/typescript-eslint/typescript-eslint/issues/10940).
import { registerHooks } from 'node:module';

const LINT_PACKAGES = /[\\/]node_modules[\\/](?:@typescript-eslint[\\/][^\\/]+|typescript-eslint|ts-api-utils)[\\/]/;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === 'typescript' || specifier.startsWith('typescript/')) && LINT_PACKAGES.test(context.parentURL ?? '')) {
      return nextResolve(specifier.replace(/^typescript/, '@typescript/typescript6'), context);
    }
    return nextResolve(specifier, context);
  },
});

// Loaded after the hook is registered (static imports would run first).
const { default: js } = await import('@eslint/js');
const { default: tseslint } = await import('typescript-eslint');
const { default: reactHooks } = await import('eslint-plugin-react-hooks');
const { default: globals } = await import('globals');

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'android/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'media/**',
      'docs/**',
      'fastlane/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Preact hooks follow the same rules as React's. Only the two classic rules: the
      // React Compiler rules in the plugin's newer presets don't apply to Preact.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['tests/**/*.ts', '*.config.{ts,js}', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Warnings for now: these still fire in the current tree (auto-fixable with --fix).
      // Raise to 'error' once the count is 0.
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Test doubles and fixtures may use `any` freely.
    files: ['tests/**/*.ts', 'src/**/*.test.ts', 'src/**/__fixtures__/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
