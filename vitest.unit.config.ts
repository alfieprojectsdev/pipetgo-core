import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      'server-only': new URL('./src/test/server-only-mock.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [],
    include: [
      // Every __tests__/ directory must have a corresponding glob entry —
      // a missing glob silently drops all tests in that directory from the run.
      'src/lib/storage/__tests__/**/*.test.ts',
      'src/features/labs/kyc-upload/__tests__/**/*.test.ts',
      'src/features/labs/accreditation-upload/__tests__/**/*.test.ts',
      'src/features/payments/checkout/__tests__/kyc-gate.test.ts',
      'src/features/admin/kyc-review/__tests__/**/*.test.ts',
      'src/features/admin/accreditation-review/__tests__/**/*.test.ts',
      'src/features/services/browse/__tests__/**/*.test.ts',
      'src/features/orders/create-order/__tests__/**/*.test.ts',
      'src/features/orders/spec-upload/__tests__/**/*.test.ts',
      'src/features/orders/result-upload/__tests__/**/*.test.ts',
      'src/features/admin/order-oversight/__tests__/**/*.test.ts',
    ],
  },
})
