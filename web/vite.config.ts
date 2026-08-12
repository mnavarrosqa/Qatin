import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8545',
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            if (
              req.url?.includes('/chat/sessions/') &&
              req.url.includes('/messages')
            ) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
      '/health': 'http://localhost:8545',
    },
  },
})
