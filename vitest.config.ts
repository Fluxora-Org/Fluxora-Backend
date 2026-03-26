import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text'],
      include: ['src/middleware/rateLimiter.ts', 'src/config/rateLimits.ts', 'src/routes/rateLimits.ts'],
      thresholds: {
        functions: 95,
        branches: 80,
        lines: 90,
      },
    },
  },
});
