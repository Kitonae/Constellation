import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.js',
    exclude: ['tests/**', 'node_modules/**'],
  },
})

