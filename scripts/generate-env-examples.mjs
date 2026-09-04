import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function isTextFile(p) {
  return /\.(cjs|mjs|js|jsx|ts|tsx)$/.test(p)
}

const FALLBACK_EXCLUDED_DIRS = new Set([
  '.git',
  '.github',
  '.cursor',
  '.claude',
  '.vercel',
  'node_modules',
  'dist',
  'coverage',
  'audit-dist',
  'audit-reports',
  'playwright-report',
  'test-results',
])

function enumerateFilesystemSources(root = repoRoot) {
  const out = []

  const visit = (absoluteDir, relativeDir = '') => {
    let entries = []
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const absolute = path.join(absoluteDir, entry.name)

      if (entry.isDirectory()) {
        if (FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue
        if (
          relative === 'backend/data' ||
          relative === 'backend/uploads' ||
          relative === 'backend/temp_images'
        ) continue
        visit(absolute, relative)
        continue
      }

      if (!entry.isFile()) continue
      if (relative.startsWith('.cursor/') || relative.startsWith('.claude/')) continue
      if (isTextFile(relative)) out.push(absolute)
    }
  }

  visit(root)
  return out
}

/**
 * Enumerate source files deterministically.
 *
 * A normal checkout uses tracked plus non-ignored untracked `git ls-files`
 * output so a newly added source file cannot introduce an undocumented env
 * contract before it is staged. Docker intentionally excludes `.git`, though.
 * In that environment we fall back to a sorted filesystem walk with build/output and
 * editor-worktree directories excluded. This keeps the generated env contract
 * reproducible without copying repository history into the image.
 */
export function enumerateSourceFiles({ forceFilesystem = false, root = repoRoot } = {}) {
  if (!forceFilesystem) {
    try {
      return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((rel) => !rel.startsWith('.cursor/') && !rel.startsWith('.claude/'))
        .filter(isTextFile)
        .map((rel) => path.join(root, rel))
        // `git ls-files` still lists an unstaged deletion. Release preparation
        // must be able to regenerate/check examples before the deletion is
        // staged, so ignore paths that no longer exist in the working tree.
        .filter((absolute) => fs.existsSync(absolute))
        .sort()
    } catch {
      // Docker builders and source archives deliberately have no .git metadata.
    }
  }

  return enumerateFilesystemSources(root)
}

function walk() {
  return enumerateSourceFiles()
}

export function extractEnvReferences(source) {
  const references = []
  const patterns = [
    { kind: 'process.env', re: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g },
    { kind: 'process.env', re: /\bprocess\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g },
    { kind: 'import.meta.env', re: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g },
    {
      kind: 'env helper',
      re: /\b(?:readEnv(?:Bool|Int|String|Flag|Number)?|requireEnv|requiredEnv|reqEnv|boolEnv(?:Disabled)?|intEnv|boundedIntEnv|parseEnvList)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    },
  ]
  for (const { kind, re } of patterns) {
    let match
    while ((match = re.exec(String(source || '')))) {
      references.push({ varName: match[1], kind, index: match.index })
    }
  }

  // A small number of runtime readers intentionally use a canonical *_ENV_KEYS
  // registry and then index process.env dynamically. Preserve those statically
  // declared keys without treating arbitrary uppercase strings as env names.
  const registryRe = /\b(?:const|let|var)\s+[A-Z0-9_]*ENV_KEYS[A-Z0-9_]*\s*=\s*(?:Object\.freeze\(\s*)?\{([\s\S]*?)\}\s*\)?/g
  let registry
  while ((registry = registryRe.exec(String(source || '')))) {
    const body = registry[1]
    const valueRe = /:\s*['"]([A-Z][A-Z0-9_]*)['"]/g
    let value
    while ((value = valueRe.exec(body))) {
      references.push({
        varName: value[1],
        kind: 'env key registry',
        index: registry.index + value.index,
      })
    }
  }
  return references
}

export function extractEnvVars(source) {
  return new Set(extractEnvReferences(source).map((reference) => reference.varName))
}

// Keep documented examples aligned with the runtime's bounded, fail-safe
// defaults. Generic placeholder inference cannot know that ClamAV speaks on
// 3310 (rather than an HTTP port), or that the NOFO parser's values are safety
// ceilings. Centralizing these values here also prevents a regenerated example
// from silently weakening or obscuring those production limits.
const DOCUMENTED_RUNTIME_DEFAULTS = Object.freeze({
  CLAMAV_PORT: '3310',
  CLAMAV_REQUIRED: 'false',
  CLAMAV_TIMEOUT_MS: '10000',
  ERROR_REPORT_LLM_ANALYSIS_ENABLED: 'false',
  // Hamilton's unattended poller defaults ON (hamiltonScheduler.js,
  // shouldRunOnSchedule). Documented here so the generated examples state the
  // real default rather than an empty value that reads as "off".
  HAMILTON_RUN_ON_SCHEDULE: 'true',
  NOFO_FETCH_MAX_BYTES: '20971520',
  NOFO_FETCH_TIMEOUT_MS: '20000',
  NOFO_PARSE_CHUNK_CHARS: '14000',
  NOFO_PARSE_CHUNK_OVERLAP: '600',
  NOFO_PARSE_MAX_TEXT_CHARS: '2000000',
  PROFILE_SCORING_MAX_CANDIDATES: '25000',
})

function placeholderFor(name) {
  const upper = String(name || '').toUpperCase()
  if (Object.hasOwn(DOCUMENTED_RUNTIME_DEFAULTS, upper)) {
    return DOCUMENTED_RUNTIME_DEFAULTS[upper]
  }
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

  if (upper === 'JOHN_PRIMARY_MAILBOX') return 'dr.johnwhite@axiombiolabs.org'
  if (upper === 'JOHN_FROM_ALIAS' || upper === 'JOHN_REPLY_TO') return 'Annie@axiombiolabs.org'
  if (upper === 'YANA_TARGET_AREAS') return 'Bradley County, TN; Lorain County, OH; Erie County, OH'
  if (upper === 'JOHN_DISPLAY_NAME') return 'Annie | GrantFlow'

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
  const files = walk()

  const backendVars = new Set()
  const frontendVars = new Set()

  for (const file of files) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/')
    const src = fs.readFileSync(file, 'utf8')
    const vars = extractEnvVars(src)

    for (const v of vars) {
      if (v.startsWith('VITE_') || rel.startsWith('src/')) {
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
        ? 'admin@example.invalid'
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
        ? 'admin@example.invalid'
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
const isMain = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
