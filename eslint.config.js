import parser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    files: ['**/*.ts'],
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.eslint.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // General strictness
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',

      // Production code must use the structured logger. The CLI backup tool
      // is the only source exception; test spies are exempted below.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Enforce explicit return types on public API and indexer methods.
      // Applies to exported functions and class methods.
      '@typescript-eslint/explicit-module-boundary-types': [
        'error',
        {
          allowArgumentsExplicitlyTypedAsAny: false,
          allowDirectConstAssertionInArrowFunctions: true,
          allowHigherOrderFunctions: false,
          allowTypedFunctionExpressions: true,
        },
      ],

      // Prevent floating-point arithmetic on variables named "amount" or "balance".
      // Using parseFloat / Number() on these fields silently drops decimal precision.
      // All amount/balance values must remain as decimal strings per the serialization policy.
      'no-restricted-syntax': [
        'error',
        {
          // Disallow: parseFloat(amount), parseFloat(balance), parseFloat(x.amount), etc.
          selector:
            'CallExpression[callee.name="parseFloat"] > Identifier[name=/amount|balance/i]',
          message:
            'Do not convert amount/balance fields with parseFloat — keep them as decimal strings.',
        },
        {
          selector:
            'CallExpression[callee.name="parseFloat"] > MemberExpression > Identifier[name=/amount|balance/i]',
          message:
            'Do not convert amount/balance fields with parseFloat — keep them as decimal strings.',
        },
        {
          // Disallow: Number(amount), Number(balance)
          selector:
            'CallExpression[callee.name="Number"] > Identifier[name=/amount|balance/i]',
          message:
            'Do not convert amount/balance fields with Number() — keep them as decimal strings.',
        },
        {
          selector:
            'CallExpression[callee.name="Number"] > MemberExpression > Identifier[name=/amount|balance/i]',
          message:
            'Do not convert amount/balance fields with Number() — keep them as decimal strings.',
        },
        {
          // Disallow unary + on amount/balance: +amount, +balance
          selector: 'UnaryExpression[operator="+"] > Identifier[name=/amount|balance/i]',
          message:
            'Do not coerce amount/balance fields with unary + — keep them as decimal strings.',
        },
      ],
    },
  },
  {
    // This file is a deliberately standalone CLI entrypoint. It is allowed
    // to write human-readable progress directly to the terminal before any
    // request-scoped logger exists; see docs/CONSOLE_LOG_AUDIT.md.
    files: ['src/scripts/backup-retention.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Relax return-type enforcement in test files — not part of the public API surface.
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
// NOTE: a previous block here enabled an 'unused-exports/no-unused-exports'
  // rule via an `unusedExports` plugin binding that was never defined (and the
  // eslint-plugin-unused-exports package is not a dependency), which made every
  // eslint invocation crash with `ReferenceError: unusedExports is not defined`.
  // The dead block was removed so linting can run.
  prettierConfig,
];
