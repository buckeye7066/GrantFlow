import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  enumerateSourceFiles,
  extractEnvReferences,
} from './generate-env-examples.mjs'

const ROOT = path.resolve(process.cwd())

function scanEnvUsages(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  return extractEnvReferences(text).map((reference) => {
    const line = text.slice(0, reference.index).split(/\r?\n/).length
    return {
      varName: reference.varName,
      kind: reference.kind,
      file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      line,
      excerpt: String(lines[line - 1] || '').trim(),
    }
  })
}

export function parseEnvExample(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const vars = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) line = line.slice(1).trim()
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
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

export function main() {
  const files = enumerateSourceFiles({ root: ROOT })
  const usage = files.flatMap(scanEnvUsages)
  const usageByVar = groupByVar(usage)

  const envExampleFiles = [
    '.env.example',
    'backend/.env.example',
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
  lines.push('This file is generated from first-party source present in the checkout and the generated')
  lines.push('example templates. “Referenced” means a static source reference; “Listed in')
  lines.push('templates” includes commented optional entries. Presence here does not prove that a')
  lines.push('variable is required, configured in Vercel/Railway, or safe to log; production')
  lines.push('requirements remain in `docs/ENVIRONMENT.md`.')
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total vars: **${allVarNames.length}**`)
  lines.push(`- Vars referenced in code: **${usageByVar.size}**`)
  lines.push(`- Vars listed in env templates: **${exampleByVar.size}**`)
  lines.push('')

  lines.push('## Inventory')
  lines.push('')
  lines.push('| Name | Referenced in code | Listed in templates | Notes |')
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
    } else if (code.length) {
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

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
