import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function isTextFile(p) {
  return /\.(cjs|mjs|js|jsx|ts|tsx)$/.test(p)
}

function walk(dir) {
  const out = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build' || ent.name === 'coverage') continue
      out.push(...walk(full))
      continue
    }
    if (ent.isFile() && isTextFile(full)) out.push(full)
  }
  return out
}

function extractEnvVars(source) {
  const vars = new Set()
  const patterns = [
    /process\.env\.([A-Z0-9_]+)/g,
    /process\.env\[['"]([A-Z0-9_]+)['"]\]/g,
    /import\.meta\.env\.([A-Z0-9_]+)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source))) vars.add(m[1])
  }
  return vars
}

function placeholderFor(name) {
  const upper = String(name || '').toUpperCase()
  const isFlag =
    upper.startsWith('ALLOW_') ||
    upper.startsWith('ENABLE_') ||
    upper.startsWith('FEATURE_') ||
    upper.endsWith('_TTL') ||
    upper.endsWith('_ENABLED') ||
    upper.endsWith('_DRY_RUN') ||
    upper.endsWith('_STRICT')

  const isSecret =
    !isFlag &&
    (upper === 'SESSION_SECRET' ||
      upper.endsWith('_SECRET') ||
      upper.includes('_SECRET_') ||
      upper.endsWith('_TOKEN') ||
      upper.includes('_TOKEN_') ||
      upper.includes('PASSWORD') ||
      upper.endsWith('_API_KEY') ||
      upper.includes('_API_KEY_') ||
      upper.endsWith('_KEY') ||
      upper.includes('_KEY_') ||
      upper.includes('AUTH_TOKEN') ||
      upper.includes('ACCOUNT_SID') ||
      upper.includes('CLIENT_SECRET') ||
      upper === 'RUNTIME_SECRETS_KEY')

  if (isSecret) return '<REPLACE_ME>'

  // Ports: only explicit *PORT vars (avoid substrings like OPPORTUNITIES).
  if (upper === 'PORT' || upper.endsWith('_PORT') || upper === 'BACKEND_PORT' || upper === 'PREVIEW_PORT') return '8080'
  if (upper === 'PGPORT' || upper === 'POSTGRES_PORT') return '5432'

  // URLs: only explicit *_URL vars (avoid substrings like URLS).
  if (
    upper === 'DATABASE_URL' ||
    upper.endsWith('_URL') ||
    upper === 'PUBLIC_URL' ||
    upper === 'AUTH_PUBLIC_URL' ||
    upper === 'AUTH_FRONTEND_URL' ||
    upper === 'FRONTEND_BASE_URL' ||
    upper === 'BACKEND_BASE_URL' ||
    upper === 'API_BASE_URL' ||
    upper === 'API_URL' ||
    upper === 'DATABASE_PUBLIC_URL'
  ) {
    if (upper === 'DATABASE_URL') return 'postgres://USER:PASSWORD@HOST:5432/DBNAME'
    return 'http://127.0.0.1:8080'
  }

  // TTLs (seconds)
  if (upper.endsWith('_TTL')) return '600'

  return ''
}

function renderEnvExample({ title, lines }) {
  return [
    `# ${title}`,
    '#',
    '# This file is generated from code references via:',
    '#   node scripts/generate-env-examples.mjs',
    '#',
    ...lines,
    '',
  ].join('\n')
}

/**
 * Build the rendered contents for both env example files in memory.
 * Exposed so scripts/check-env-examples.mjs can run the generator
 * without writing to disk and compare against the checked-in versions.
 */
export function buildOutputs() {
  const files = walk(repoRoot)

  const backendVars = new Set()
  const frontendVars = new Set()

  for (const file of files) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/')
    const src = fs.readFileSync(file, 'utf8')
    const vars = extractEnvVars(src)

    for (const v of vars) {
      if (rel.startsWith('src/')) {
        frontendVars.add(v)
      } else if (rel.startsWith('backend/')) {
        backendVars.add(v)
      } else if (rel.startsWith('scripts/') || rel.startsWith('tests/')) {
        // Root scripts/tests typically exercise backend/runtime behaviors.
        backendVars.add(v)
      } else {
        backendVars.add(v)
      }
    }
  }

  // Frontend: only VITE_* is configurable via .env (Vite also provides DEV/PROD/BASE_URL automatically).
  const viteVars = [...frontendVars].filter((v) => v.startsWith('VITE_')).sort()
  const viteBuiltins = [...frontendVars].filter((v) => !v.startsWith('VITE_')).sort()

  const backendList = [...backendVars].sort()

  const rootLines = []
  rootLines.push('# ---- Frontend (Vite) ----')
  rootLines.push('# Vite provides these automatically (do not set in .env):')
  for (const v of viteBuiltins) rootLines.push(`# - ${v}`)
  rootLines.push('')
  rootLines.push('# Configure Vite-exposed variables:')
  for (const v of viteVars) {
    const val =
      v === 'VITE_APP_BASE'
        ? '/grantflow'
        : v === 'VITE_API_URL'
          ? ''
          : placeholderFor(v)
    // For local dev the recommended default is relative `/api` via vite proxy (leave VITE_API_URL unset).
    if (v === 'VITE_APP_BASE') {
      rootLines.push(`${v}=${val}`)
    } else {
      rootLines.push(val ? `# ${v}=${val}` : `# ${v}=`)
    }
  }
  rootLines.push('')
  rootLines.push('# ---- Backend / scripts ----')
  rootLines.push('# NOTE: `npm run backend` loads .env from the repo root.')

  const defaultUncommented = new Set([
    'ADMIN_EMAIL',
    'ADMIN_NAME',
    'DB_PROVIDER',
    'SQLITE_DB_PATH',
    'PORT',
  ])

  for (const v of backendList) {
    // Avoid duplicating Vite vars in the backend section
    if (v.startsWith('VITE_')) continue
    const val =
      v === 'ADMIN_EMAIL'
        ? 'buckeye7066@gmail.com'
        : v === 'ADMIN_NAME'
          ? 'Admin User'
          : v === 'DB_PROVIDER'
            ? 'sqlite'
            : v === 'SQLITE_DB_PATH'
              ? 'backend/data/grantflow.dev.db'
              : placeholderFor(v)
    if (defaultUncommented.has(v)) {
      rootLines.push(`${v}=${val}`)
    } else {
      rootLines.push(val ? `# ${v}=${val}` : `# ${v}=`)
    }
  }

  const backendLines = []
  backendLines.push('# ---- Backend-only subset ----')
  backendLines.push('# This file is informational; local boot uses the repo-root .env by default.')
  backendLines.push('')
  for (const v of backendList) {
    if (v.startsWith('VITE_')) continue
    const val =
      v === 'ADMIN_EMAIL'
        ? 'buckeye7066@gmail.com'
        : v === 'ADMIN_NAME'
          ? 'Admin User'
          : v === 'DB_PROVIDER'
            ? 'sqlite'
            : v === 'SQLITE_DB_PATH'
              ? 'backend/data/grantflow.dev.db'
              : placeholderFor(v)
    backendLines.push(val ? `# ${v}=${val}` : `# ${v}=`)
  }

  return {
    rootEnvExample: renderEnvExample({ title: 'GrantFlow env example (root)', lines: rootLines }),
    backendEnvExample: renderEnvExample({ title: 'GrantFlow env example (backend)', lines: backendLines }),
  }
}

function main() {
  const { rootEnvExample, backendEnvExample } = buildOutputs()
  fs.writeFileSync(path.join(repoRoot, '.env.example'), rootEnvExample)
  fs.mkdirSync(path.join(repoRoot, 'backend'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'backend', '.env.example'), backendEnvExample)
  console.log('Wrote .env.example and backend/.env.example')
}

// Only run main() when invoked as a script — not when imported.
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(path.basename(process.argv[1] || ''))
if (isMain) {
  main()
}

