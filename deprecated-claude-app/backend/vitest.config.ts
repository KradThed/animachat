import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      JWT_SECRET: 'test-secret-key-for-vitest-minimum-32-chars',
      ENCRYPTION_KEY: 'test-encryption-key-for-vitest-minimum-32-chars',
    },
  },
});
