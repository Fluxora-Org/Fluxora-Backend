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
    // Relax return-type enforcement in test files — not part of the public API surface.
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  prettierConfig,
];
