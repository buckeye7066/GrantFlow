import fs from 'node:fs'
import path from 'node:path'

/**
 * Contract audit (frontend ↔ backend) with zero credentials.
 *
 * What it does:
 * - Extracts Express route paths from backend/server.js
 * - Extracts API paths referenced in src/api/ (TypeScript/JS files)
 * - Reports:
 *   - frontend paths that have no matching backend route
 *   - backend routes that are never referenced by the frontend
 */

const ROOT = path.resolve(process.cwd())
const BACKEND_ENTRY = path.join(ROOT, 'backend', 'server.js')
const FRONTEND_API_DIR = path.join(ROOT, 'src', 'api')

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function listFilesRec(dir, exts) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listFilesRec(p, exts))
    else if (exts.includes(path.extname(ent.name))) out.push(p)
  }
  return out
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a.localeCompare(b))
}

function extractExpressRoutes(serverJs) {
  // Matches: app.get('/api/x', ...) and app.post("/api/x", ...)
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2\s*,/g
  const routes = []
  let m
  while ((m = re.exec(serverJs))) {
    routes.push(m[3])
  }
  return uniqSorted(routes)
}

function extractFrontendApiPaths(text) {
  // Heuristic: capture strings that look like /api/... or `${API_BASE}/api/...`
  // We normalize to start at /api/.
  const found = []

  const normalize = (raw) => {
    // Replace template interpolations and strip query-strings for route matching.
    return raw
      .replace(/\$\{[^}]+\}/g, ':param')
      .split('?')[0]
  }

  const direct = /(['"`])\/(api\/[^'"`\s]+)\1/g
  let m
  while ((m = direct.exec(text))) {
    found.push(normalize(`/${m[2]}`))
  }

  return uniqSorted(found)
}

function main() {
  if (!fs.existsSync(BACKEND_ENTRY)) {
    console.error(`Missing backend entry: ${BACKEND_ENTRY}`)
    process.exit(1)
  }
  if (!fs.existsSync(FRONTEND_API_DIR)) {
    console.error(`Missing frontend api dir: ${FRONTEND_API_DIR}`)
    process.exit(1)
  }

  const backendText = readText(BACKEND_ENTRY)
  const backendRoutes = extractExpressRoutes(backendText)

  const apiFiles = listFilesRec(FRONTEND_API_DIR, ['.ts', '.tsx', '.js', '.jsx'])
  const frontendPaths = uniqSorted(
    apiFiles.flatMap((fp) => extractFrontendApiPaths(readText(fp))),
  )

  const matchesBackend = (frontendPath, backendPath) => {
    if (frontendPath === backendPath) return true
    // Support common template patterns like /api/anya/:param matching /api/anya/scan
    if (frontendPath.includes(':param')) {
      const prefix = frontendPath.split(':param')[0]
      if (backendPath.startsWith(prefix) && backendPath.length > prefix.length) return true
    }
    return false
  }

  const frontendMissing = frontendPaths.filter(
    (fp) => !backendRoutes.some((br) => matchesBackend(fp, br)),
  )

  const backendUnreferenced = backendRoutes.filter(
    (br) => !frontendPaths.some((fp) => matchesBackend(fp, br)),
  )

  console.log('=== Contract audit (frontend ↔ backend) ===')
  console.log(`Backend routes found: ${backendRoutes.length}`)
  console.log(`Frontend API paths found: ${frontendPaths.length}`)
  console.log('')

  if (frontendMissing.length) {
    console.log('Frontend references with NO matching backend route:')
    for (const p of frontendMissing) console.log(`  - ${p}`)
  } else {
    console.log('Frontend references: all matched to backend routes.')
  }

  console.log('')

  if (backendUnreferenced.length) {
    console.log('Backend routes NOT referenced by frontend (may be admin-only / future / unused):')
    for (const p of backendUnreferenced) console.log(`  - ${p}`)
  } else {
    console.log('Backend routes: all referenced by frontend.')
  }
}

main()
