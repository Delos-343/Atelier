import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['src/lib/security/**/*.test.ts'],
  },
});
