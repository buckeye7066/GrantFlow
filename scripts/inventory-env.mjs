import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())

function isTextFile(filePath) {
  return /\.(mjs|cjs|js|jsx|ts|tsx|json)$/i.test(filePath)
}

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'artifacts') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (ent.isFile() && isTextFile(full)) out.push(full)
  }
  return out
}

function scanEnvUsages(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const matches = []

  const reProcess = /\bprocess\.env\.([A-Z0-9_]+)\b/g
  const reImportMeta = /\bimport\.meta\.env\.([A-Z0-9_]+)\b/g

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const re of [reProcess, reImportMeta]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line))) {
        matches.push({
          varName: m[1],
          kind: re === reProcess ? 'process.env' : 'import.meta.env',
          file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
          line: i + 1,
          excerpt: line.trim(),
        })
      }
    }
  }
  return matches
}

function parseEnvExample(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const vars = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z0-9_]+$/.test(key)) continue
    const value = line.slice(eq + 1)
    vars.push({
      varName: key,
      file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      line: i + 1,
      value,
    })
  }
  return vars
}

function groupByVar(usages) {
  const map = new Map()
  for (const u of usages) {
    if (!map.has(u.varName)) map.set(u.varName, [])
    map.get(u.varName).push(u)
  }
  return map
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|')
}

function formatLineRange(lines) {
  if (lines.length === 1) return `${lines[0]}-${lines[0]}`
  const sorted = [...lines].sort((a, b) => a - b)
  return `${sorted[0]}-${sorted[sorted.length - 1]}`
}

function parseBackendRequiredEnvVars() {
  try {
    const serverPath = path.join(ROOT, 'backend', 'server.js')
    const text = fs.readFileSync(serverPath, 'utf8')
    const m = text.match(/const\s+requiredEnvVars\s*=\s*\[([^\]]*)\]/)
    if (!m) return new Set()
    const raw = m[1]
    const vars = raw
      .split(',')
      .map((s) => s.trim())
      .map((s) => s.replace(/^['"`]/, '').replace(/['"`]$/, ''))
      .filter(Boolean)
    return new Set(vars)
  } catch {
    return new Set()
  }
}

function isProbablySecret(name) {
  return /(_KEY|_SECRET|_TOKEN|_DSN|PASSWORD|TWILIO_AUTH_TOKEN)$/i.test(name)
}

function requiredness(name, backendRequiredSet) {
  if (backendRequiredSet.has(name)) return 'Required (prod)'
  // Build/runtime critical for local operation (even if defaults exist)
  if (name === 'DATABASE_URL') return 'Required (local-run)'
  if (name === 'AUTH_JWT_SECRET') return 'Required (prod)'
  if (name === 'PORT') return 'Optional'
  if (name.startsWith('VITE_')) return 'Optional'
  return isProbablySecret(name) ? 'Optional (feature-gated)' : 'Optional'
}

function pickDevDefault(name, defs, codeRefs) {
  // Prefer template value if present.
  const template = defs?.[0]?.value
  if (typeof template === 'string' && template.length > 0) return template

  // Common safe dev defaults (never production defaults).
  const safe = {
    PORT: '8080',
    NODE_ENV: 'development',
    VITE_APP_BASE: '/grantflow',
    VITE_ASSET_BASE: '/grantflow',
    VITE_API_URL: 'http://localhost:8080',
    VITE_API_PROXY_TARGET: 'http://localhost:8080',
    ADMIN_TOKEN: 'dev-admin-token',
    AUTH_JWT_SECRET: 'dev-secret-change-me',
    BULK_POPULATE_KEY: 'grantflow-bulk-2026',
  }
  if (safe[name]) return safe[name]

  // If referenced in code with obvious fallback literals, show "has code fallback".
  if (Array.isArray(codeRefs) && codeRefs.some((c) => /process\.env\.[A-Z0-9_]+\s*\|\|/.test(c.excerpt))) {
    return '(has code fallback)'
  }

  return ''
}

function main() {
  const files = walk(ROOT)
  const usage = files.flatMap(scanEnvUsages)
  const usageByVar = groupByVar(usage)
  const backendRequired = parseBackendRequiredEnvVars()

  const envExampleFiles = [
    '.env.example',
    'env.example',
    'backend/.env.example',
    'backend/env.example',
  ]
    .map((p) => path.join(ROOT, p))
    .filter((p) => fs.existsSync(p))

  const exampleVars = envExampleFiles.flatMap(parseEnvExample)
  const exampleByVar = new Map()
  for (const v of exampleVars) {
    if (!exampleByVar.has(v.varName)) exampleByVar.set(v.varName, [])
    exampleByVar.get(v.varName).push(v)
  }

  const allVarNames = Array.from(
    new Set([...usageByVar.keys(), ...exampleByVar.keys()]),
  ).sort()

  const lines = []
  lines.push('# ENV Vars Inventory')
  lines.push('')
  lines.push('This file is **generated** by `node scripts/inventory-env.mjs`.')
  lines.push('It enumerates environment variables referenced in code and/or present in example env files.')
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total vars: **${allVarNames.length}**`)
  lines.push(`- Vars referenced in code: **${usageByVar.size}**`)
  lines.push(`- Vars present in env templates: **${exampleByVar.size}**`)
  lines.push('')

  lines.push('## Inventory')
  lines.push('')
  lines.push('| Name | Required? | Default / dev value | Referenced in code | Defined in templates | Notes |')
  lines.push('| --- | --- | --- | --- | --- | --- |')

  for (const name of allVarNames) {
    const code = usageByVar.get(name) || []
    const defs = exampleByVar.get(name) || []
    const referenced = code.length ? 'Yes' : 'No'
    const defined = defs.length ? 'Yes' : 'No'
    const req = requiredness(name, backendRequired)
    const devDefault = mdEscape(pickDevDefault(name, defs, code))
    const notes = []
    if (code.some((u) => u.kind === 'process.env') && code.some((u) => u.kind === 'import.meta.env')) {
      notes.push('Used in both backend + frontend')
    } else if (code.some((u) => u.kind === 'import.meta.env')) {
      notes.push('Frontend (Vite)')
    } else if (code.some((u) => u.kind === 'process.env')) {
      notes.push('Backend/Node')
    }
    lines.push(`| \`${name}\` | ${req} | ${devDefault} | ${referenced} | ${defined} | ${mdEscape(notes.join('; '))} |`)
  }

  lines.push('')
  lines.push('## Usage locations (file + line ranges)')
  lines.push('')

  for (const name of allVarNames) {
    const code = usageByVar.get(name) || []
    const defs = exampleByVar.get(name) || []

    lines.push(`### \`${name}\``)
    lines.push('')

    if (defs.length) {
      lines.push('- **Templates**:')
      for (const d of defs) {
        lines.push(`  - \`${d.file}:${d.line}\` = \`${d.value}\``)
      }
    } else {
      lines.push('- **Templates**: (not present)')
    }

    if (code.length) {
      const byFile = new Map()
      for (const u of code) {
        if (!byFile.has(u.file)) byFile.set(u.file, [])
        byFile.get(u.file).push(u)
      }
      lines.push('- **Code references**:')
      for (const [file, entries] of Array.from(byFile.entries()).sort()) {
        const lineNums = entries.map((e) => e.line)
        lines.push(`  - \`${file}:${formatLineRange(lineNums)}\` (${entries[0].kind})`)
      }
    } else {
      lines.push('- **Code references**: (none)')
    }

    lines.push('')
  }

  const outPath = path.join(ROOT, 'docs', 'ENV_VARS.md')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8')
  console.log(`Wrote ${path.relative(ROOT, outPath)}`)
}

main()

