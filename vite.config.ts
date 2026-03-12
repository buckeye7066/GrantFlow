import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080'
  const normalizeViteBase = (base: string | undefined) => {
    const b = String(base || '/').trim()
    if (b === '' || b === '/') return '/'
    return b.endsWith('/') ? b : (b + '/')
  }

  const assetBaseRaw = env.VITE_ASSET_BASE || (mode === 'production' ? '/grantflow/' : '/')
  const assetBase = normalizeViteBase(assetBaseRaw)

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
        '/uploads': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
      allowedHosts: true,
    },
    build: {
      target: 'es2020',
      cssMinify: true,
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 1000,
      cssCodeSplit: true,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
                return 'react-vendor'
              }
              if (id.includes('@tanstack/react-query')) {
                return 'query'
              }
              if (id.includes('@radix-ui')) {
                return 'radix-ui'
              }
              if (id.includes('recharts')) {
                return 'recharts'
              }
              if (id.includes('framer-motion')) {
                return 'framer-motion'
              }
              if (id.includes('date-fns')) {
                return 'date-fns'
              }
              if (id.includes('lucide-react')) {
                return 'lucide-react'
              }
              if (id.includes('zustand')) {
                return 'zustand'
              }
              if (id.includes('zod')) {
                return 'zod'
              }
            }
          },
        },
      },
    },
  }
})
