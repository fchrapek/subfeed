import { defineConfig } from 'vitest/config'

// Tests cover the server only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
  },
})
