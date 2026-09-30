import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
