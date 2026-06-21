import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guard: backend RUNTIME code must never import from the repo-root frontend
 * `src/` directory.
 *
 * Why this exists: backend/routes/profilePortals.js imported a pure helper from
 * `../../src/components/hamilton/applicationPacketHtml.js`. That path resolves in
 * local dev (where the whole repo is on disk) but the production backend image
 * does NOT ship the frontend `src/` tree, so `await import()` threw at runtime.
 * Mounted via lazyRouter at a catch-all `/api`, the swallowed rejection hung
 * every request routed through it (→ gateway 504s on /api/me, /api/admin/*,
 * /api/hamilton/automation/*). Shared, dependency-free helpers belong in
 * `shared/` (which IS in the backend image), not under `src/`.
 *
 * Note: `backend/src/` is a DIFFERENT, legitimate directory — only the
 * repo-root `src/` (the frontend) is off-limits to the backend at runtime.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const FRONTEND_SRC = path.join(REPO_ROOT, 'src') + path.sep
const BACKEND_DIR = path.join(REPO_ROOT, 'backend')

// Not part of the request-serving runtime: tests cross-check frontend modules,
// and scripts are run by hand, never inside an HTTP handler.
const SKIP_DIRS = new Set(['node_modules', 'tests', 'scripts'])

function collectJsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...collectJsFiles(path.join(dir, entry.name)))
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const IMPORT_RE = /(?:import\s[^'"]*from\s*|import\s*\(\s*|export\s[^'"]*from\s*)['"]([^'"]+)['"]/g

describe('backend runtime never imports from the frontend src/ tree', () => {
  it('has no backend route/service importing repo-root src/', () => {
    const offenders = []
    for (const file of collectJsFiles(BACKEND_DIR)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1]
        if (!spec.startsWith('.')) continue // bare/package import — not a path
        const resolved = path.resolve(path.dirname(file), spec)
        if ((resolved + path.sep).startsWith(FRONTEND_SRC)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`)
        }
      }
    }
    expect(
      offenders,
      `Backend runtime files must not import the frontend src/ tree (it is absent from the prod backend image and hangs at runtime). Move shared helpers to shared/. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
