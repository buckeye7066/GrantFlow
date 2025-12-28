#!/usr/bin/env node
import app from '../backend/server.js'

function collectRoutes(expressApp) {
  const routes = new Map()

  const stack = expressApp?._router?.stack ?? []
  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods ?? {}).filter(Boolean).map((method) => method.toUpperCase())
      const entry = routes.get(layer.route.path) ?? new Set()
      for (const method of methods) {
        entry.add(method)
      }
      routes.set(layer.route.path, entry)
    } else if (layer.handle?.stack) {
      for (const sub of layer.handle.stack) {
        if (sub.route?.path) {
          const methods = Object.keys(sub.route.methods ?? {}).filter(Boolean).map((method) => method.toUpperCase())
          const entry = routes.get(sub.route.path) ?? new Set()
          for (const method of methods) {
            entry.add(method)
          }
          routes.set(sub.route.path, entry)
        }
      }
    }
  }
  return routes
}

const expected = [
  { method: 'GET', path: '/api/anya/status' },
  { method: 'GET', path: '/api/anya/logs' },
  { method: 'POST', path: '/api/anya/scan' },
  { method: 'POST', path: '/api/anya/crawl' },
  { method: 'POST', path: '/api/anya/explain' },
]

const routes = collectRoutes(app)
const mismatches = []

for (const { method, path } of expected) {
  const registered = routes.get(path)
  if (!registered || !registered.has(method)) {
    mismatches.push({ path, method, registered: registered ? Array.from(registered) : [] })
  }
}

if (mismatches.length > 0) {
  console.error('[contract-audit] Mismatches detected:')
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch.method} ${mismatch.path} -> found [${mismatch.registered.join(', ')}]`)
  }
  process.exitCode = 1
} else {
  console.log('[contract-audit] All expected endpoints are registered.')
}
