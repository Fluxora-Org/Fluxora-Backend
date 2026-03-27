/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noImplicitAny: true,
          noImplicitReturns: true,
          noFallthroughCasesInSwitch: true,
          noImplicitOverride: true,
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/index.ts',
    '!src/types/**',
    '!src/serialization/**',
    '!src/utils/**',
    '!src/cache/redis.ts',
    // config/* and indexer/* are covered by the src/ suite (jest.config.js)
    '!src/config/**',
    '!src/indexer/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
