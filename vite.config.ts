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

  const assetBaseRaw = env.VITE_ASSET_BASE || '/'
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
      rolldownOptions: {
        moduleTypes: {
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
      cssMinify: true,
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 1000,
      cssCodeSplit: true,
      minify: 'esbuild',
      target: 'es2020',
      rollupOptions: {
        output: {
          manualChunks(id) {
            const n = id.replace(/\\/g, '/')
            if (!n.includes('node_modules/')) return undefined

            if (
              /node_modules\/react(-dom)?\//.test(n) &&
              !n.includes('node_modules/react-router') &&
              !n.includes('node_modules/react-hook-form') &&
              !n.includes('node_modules/react-day-picker') &&
              !n.includes('node_modules/react-markdown') &&
              !n.includes('node_modules/react-resizable')
            ) {
              return 'react-vendor'
            }
            if (n.includes('node_modules/zustand/') || n.includes('node_modules/use-sync-external-store/')) {
              return 'zustand-vendor'
            }
            if (n.includes('node_modules/@radix-ui/')) return 'radix-ui'
            if (n.includes('node_modules/@tanstack/react-query/')) return 'query'
            if (n.includes('node_modules/recharts/')) return 'recharts'
            if (n.includes('node_modules/framer-motion/')) return 'framer-motion'
            if (n.includes('node_modules/date-fns/')) return 'date-fns'
            if (n.includes('node_modules/lucide-react/')) return 'lucide-react'
            if (n.includes('node_modules/zod/')) return 'zod'
            return undefined
          },
        },
      },
    },
  }
})
