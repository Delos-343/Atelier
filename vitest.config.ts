import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'db/**/*.test.ts'],
    pool: 'threads',
    fileParallelism: false, // DB-backed suites share one database; run files serially
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
