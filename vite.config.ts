import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api/attendance': {
        target: 'https://lambent-chimera-9ae4a2.netlify.app',
        changeOrigin: true,
      },
    },
  },
})
