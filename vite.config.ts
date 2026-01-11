import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080'
  // Default to serving under /grantflow (matches backend SPA mount + smoke tests).
  // Override with VITE_APP_BASE=/ for root deployments.
  const rawBase = env.VITE_ASSET_BASE || env.VITE_APP_BASE || '/grantflow'
  const assetBase =
    rawBase === '/'
      ? '/'
      : `/${rawBase.replace(/^\/+/, '').replace(/\/+$/, '')}/`

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
    },
  }
})
