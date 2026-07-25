import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // @aws-sdk/client-s3 is not an installed runtime dependency — it is only
      // used by the devops backup-retention script. Point the test resolver to
      // a hand-written stub so any test that transitively imports the script
      // does not fail with "Failed to load url @aws-sdk/client-s3".
      '@aws-sdk/client-s3': path.resolve(__dirname, '__mocks__/@aws-sdk/client-s3.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov', 'json'],
      reportOnFailure: true,
    },
  },
});
