import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  server: {
    // Bind IPv4 explicitly: Vite otherwise listens on [::1] only, and the Wails
    // v3 asset proxy dials tcp4 127.0.0.1, which then fails with ECONNREFUSED.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      // Wails v3 generates bindings under bindings/<go module path>/, which is
      // a long relative climb from anywhere in src/. One alias keeps the call
      // sites readable and makes a module path change a one-line edit here.
      '@bindings': fileURLToPath(new URL('./bindings/github.com/kitonae/constellation/editor', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.js',
    exclude: ['tests/**', 'node_modules/**'],
  },
})

