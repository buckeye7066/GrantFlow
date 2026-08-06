import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { deploymentVersionPlugin } from './scripts/deployment-version-plugin.mjs'

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
    plugins: [react(), deploymentVersionPlugin()],
    resolve: {
      alias: {
        // Every page-level Anya import passes through a React error boundary.
        // Keep this exact alias before the broad @ alias; SafeAnyaChat imports
        // the underlying component relatively, so there is no alias recursion.
        '@/components/anya/AnyaChat': path.resolve(__dirname, 'src/components/anya/SafeAnyaChat.jsx'),
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
        // Route-specific HTML documents keep crawler metadata truthful at the
        // HTTP boundary. Protected SPA routes use index.html (noindex), while
        // the two sitemap routes get their own canonical document heads.
        input: {
          app: path.resolve(__dirname, 'index.html'),
          welcome: path.resolve(__dirname, 'welcome.html'),
          privacy: path.resolve(__dirname, 'privacy.html'),
        },
        output: {
          // Rolldown-native chunk grouping. The previous function-form
          // manualChunks ran through rolldown's legacy compat shim, which
          // produced an inverted vendor graph: react-dom's implementation was
          // hoisted INTO the radix-ui chunk and react-vendor became a 0.18 kB
          // re-export stub of it, so anonymous deep-links to lazy routes
          // (/start) could crash with "Cannot read properties of undefined
          // (reading 'default')" when a CJS-interop namespace was read before
          // its cyclic chunk finished initializing. codeSplitting groups are
          // resolved with execution-order constraints, so each package really
          // lands in its own chunk. Groups match in order; first match wins.
          codeSplitting: {
            groups: [
              { name: 'react-vendor', test: /node_modules[\/](?:react|react-dom|scheduler|react-is)[\/]/ },
              { name: 'zustand-vendor', test: /node_modules[\/](?:zustand|use-sync-external-store)[\/]/ },
              { name: 'radix-ui', test: /node_modules[\/]@radix-ui[\/]/ },
              { name: 'query', test: /node_modules[\/]@tanstack[\/]react-query[\/]/ },
              { name: 'recharts', test: /node_modules[\/]recharts[\/]/ },
              { name: 'framer-motion', test: /node_modules[\/]framer-motion[\/]/ },
              { name: 'date-fns', test: /node_modules[\/]date-fns[\/]/ },
              { name: 'lucide-react', test: /node_modules[\/]lucide-react[\/]/ },
              { name: 'zod', test: /node_modules[\/]zod[\/]/ },
            ],
          },
        },
      },
    },
  }
})
