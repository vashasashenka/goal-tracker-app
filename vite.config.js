import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Это заставит Vercel создать файлы с НОВЫМИ именами
        assetFileNames: 'assets/[name]-[hash]-v2[extname]',
        chunkFileNames: 'assets/[name]-[hash]-v2.js',
        entryFileNames: 'assets/[name]-[hash]-v2.js',
      },
    },
  },
})
