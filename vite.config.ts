import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080'
  const assetBase = env.VITE_ASSET_BASE || '/'

  return {
    base: assetBase,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json'],
    },
    optimizeDeps: {
      esbuildOptions: {
        loader: {
          '.js': 'jsx',
        },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
      allowedHosts: true,
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) return 'react-vendor'
            if (id.includes('@radix-ui') || id.includes('lucide-react')) return 'ui-vendor'
            if (id.includes('@tanstack')) return 'query-vendor'
            if (id.includes('recharts')) return 'charts-vendor'
            if (id.includes('framer-motion')) return 'motion-vendor'
            return 'vendor'
          },
        },
      },
    },
  }
})
