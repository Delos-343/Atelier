import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Match the app's "@/..." path alias (tsconfig paths) so server modules that use it
  // can be unit-tested directly. Only affects "@/"-prefixed specifiers; existing tests
  // use relative imports and are unaffected.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'db/**/*.test.ts'],
    pool: 'threads',
    fileParallelism: false, // DB-backed suites share one database; run files serially
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
