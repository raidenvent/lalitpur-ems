import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
      // For a temporary Cloudflare Quick Tunnel, the hostname changes each run.
      // Set VITE_ALLOWED_HOST in .env for a named/known hostname, or use true
      // during local development.
      allowedHosts: env.VITE_ALLOWED_HOST ? [env.VITE_ALLOWED_HOST] : true,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY || 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  }
})
