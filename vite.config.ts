import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? '8787'}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  cacheDir: join(tmpdir(), 'oneimage-vite-cache'),
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        headers: { origin: apiTarget },
      },
    },
  },
  test: {
    // Nothing under test needs the DOM: the suites exercise pure domain logic,
    // Node-side Fastify routes, and adapters over Node's global File/Blob/fetch.
    // Booting jsdom per file accounted for ~93% of test runtime.
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
    exclude: [...configDefaults.exclude, 'providers/**'],
    // 46 concurrent workers flaked 7 tests on a memory-pressured dev box
    // (all green on rerun): the suites are fast, a bounded pool is cheap.
    maxWorkers: 8,
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor splits into its own chunk: returning visitors keep it in
        // HTTP cache across deploys (the app chunk changes every release,
        // the vendor chunk almost never).
        manualChunks(id: string) {
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
})
