import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, globalThis.process.cwd(), '')
  const proxyTarget = (env.VITE_API_URL || env.VITE_DEV_PROXY_TARGET || 'http://localhost:5001')
    .trim()
    .replace(/\/$/, '')

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          // Это заставит Vercel создать файлы с новыми именами и не держать старый бандл в кэше.
          assetFileNames: 'assets/[name]-[hash]-v2[extname]',
          chunkFileNames: 'assets/[name]-[hash]-v2.js',
          entryFileNames: 'assets/[name]-[hash]-v2.js',
        },
      },
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
