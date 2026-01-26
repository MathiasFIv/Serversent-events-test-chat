import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/thechat': {
        target: 'http://localhost:5107',
        changeOrigin: true,
        // SSE works fine through Vite's proxy as long as we don't buffer.
        // Vite uses http-proxy under the hood; no extra settings needed here.
      },
      '/swagger': {
        target: 'http://localhost:5107',
        changeOrigin: true,
      },
      '/swagger/v1': {
        target: 'http://localhost:5107',
        changeOrigin: true,
      },
      '/openapi': {
        target: 'http://localhost:5107',
        changeOrigin: true,
      },
    },
  },
})
