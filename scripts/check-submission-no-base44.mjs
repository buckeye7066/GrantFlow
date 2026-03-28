import fs from 'fs/promises'
import path from 'path'

const repoRoot = path.resolve(process.cwd())

const TARGETS = [
  'src/pages/Apply.jsx',
  'src/components/proposals',
  'src/api/apiClient.js',
  'src/api/applicationsApi.js',
]

const PATTERN = /(^|[^A-Za-z0-9_])base44([^A-Za-z0-9_]|$)|@\/api\/base44Client/i

async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function walk(dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      // Skip node_modules/dist/build outputs if they exist under weird layouts.
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue
      out.push(...(await walk(full)))
    } else if (ent.isFile()) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  const hits = []

  for (const rel of TARGETS) {
    const abs = path.join(repoRoot, rel)
    if (!(await exists(abs))) continue

    const stat = await fs.stat(abs)
    const files = stat.isDirectory() ? await walk(abs) : [abs]

    for (const file of files) {
      if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file)) continue
      const text = await fs.readFile(file, 'utf8')
      if (!PATTERN.test(text)) continue
      hits.push(path.relative(repoRoot, file))
    }
  }

  if (hits.length > 0) {
    console.error('[check-submission-no-base44] FAILED: Base44 references found in submission path files:')
    for (const h of hits) console.error(` - ${h}`)
    process.exit(1)
  }

  console.log('[check-submission-no-base44] OK: no Base44 references in submission path files')
}

main().catch((err) => {
  console.error('[check-submission-no-base44] ERROR:', err?.message || String(err))
  process.exit(1)
})

