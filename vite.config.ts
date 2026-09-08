import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'

const alias = {
  '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
  '@vault': fileURLToPath(new URL('./src/vault', import.meta.url)),
  '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
  '@i18n': fileURLToPath(new URL('./src/i18n', import.meta.url)),
}

export default defineConfig({
  plugins: [preact()],
  // Relative base so the built dist/ works from any static host or sub-path.
  base: './',
  resolve: { alias },
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
