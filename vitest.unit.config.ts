import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    setupFiles: [],
    include: [
      'src/lib/storage/__tests__/**/*.test.ts',
      'src/features/labs/kyc-upload/__tests__/**/*.test.ts',
      'src/features/payments/checkout/__tests__/kyc-gate.test.ts',
    ],
  },
})
