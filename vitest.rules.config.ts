import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Rules tests run against the Firestore emulator, not jsdom.
 * Launch with:  npm run test:rules:emulated
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/rules/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The emulator is shared mutable state; parallel files corrupt each other.
    fileParallelism: false,
  },
})
