import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
  if (lines.length === 1) return `L${lines[0]}`
  const sorted = [...lines].sort((a, b) => a - b)
  return `L${sorted[0]}–L${sorted[sorted.length - 1]}`
}

function main() {
  const files = walk(ROOT)
  const usage = files.flatMap(scanEnvUsages)
  const usageByVar = groupByVar(usage)

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
  lines.push('| Name | Referenced in code | Defined in templates | Notes |')
  lines.push('| --- | --- | --- | --- |')

  for (const name of allVarNames) {
    const code = usageByVar.get(name) || []
    const defs = exampleByVar.get(name) || []
    const referenced = code.length ? 'Yes' : 'No'
    const defined = defs.length ? 'Yes' : 'No'
    const notes = []
    if (code.some((u) => u.kind === 'process.env') && code.some((u) => u.kind === 'import.meta.env')) {
      notes.push('Used in both backend + frontend')
    } else if (code.some((u) => u.kind === 'import.meta.env')) {
      notes.push('Frontend (Vite)')
    } else if (code.some((u) => u.kind === 'process.env')) {
      notes.push('Backend/Node')
    }
    lines.push(`| \`${name}\` | ${referenced} | ${defined} | ${mdEscape(notes.join('; '))} |`)
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
  // Preserve Windows CRLF if the file already exists with CRLF to avoid dirty working trees after generation.
  let eol = os.EOL
  try {
    if (fs.existsSync(outPath)) {
      const prev = fs.readFileSync(outPath, 'utf8')
      eol = prev.includes('\r\n') ? '\r\n' : '\n'
    }
  } catch {}
  fs.writeFileSync(outPath, lines.join(eol), 'utf8')
  console.log(`Wrote ${path.relative(ROOT, outPath)}`)
}

main()

