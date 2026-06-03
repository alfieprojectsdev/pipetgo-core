import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  // tsconfig sets jsx: "preserve" for Next; esbuild then needs the runtime told
  // explicitly or it emits classic React.createElement and node-env tests that
  // render a component throw "React is not defined". Use the automatic runtime.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // `server-only` throws when loaded outside an RSC server context; under
      // vitest (node env) there is none, so stub it to a no-op for unit tests
      // of modules that import it (e.g. src/lib/storage/r2.ts).
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/_legacy_v1/**'],
  },
})
