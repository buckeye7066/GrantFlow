import fs from 'node:fs'
import path from 'node:path'

function safeParseJson(value, fallback = null) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  return Object.prototype.toString.call(value) === '[object Object]'
}

function walkPaths(value, prefix = '', out = new Set(), depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return out

  if (Array.isArray(value)) {
    if (prefix) out.add(`${prefix}[]`)
    for (const entry of value) {
      if (isPlainObject(entry) || Array.isArray(entry)) {
        walkPaths(entry, `${prefix}[]`, out, depth + 1, maxDepth)
      }
    }
    return out
  }

  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${k}` : k
      out.add(next)
      if (isPlainObject(v) || Array.isArray(v)) {
        walkPaths(v, next, out, depth + 1, maxDepth)
      }
    }
    return out
  }

  if (prefix) out.add(prefix)
  return out
}

function main() {
  const repoRoot = process.cwd()
  const seedPath = path.join(repoRoot, 'seed', 'baseline-profiles.json')
  const outPath = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(repoRoot, 'artifacts', 'local', 'profile-section-inventory.json')

  const payload = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  const sections = Array.isArray(payload?.sections) ? payload.sections : []

  const inventory = {}
  for (const row of sections) {
    const key = String(row?.section_key || '').trim()
    if (!key) continue
    const data = safeParseJson(row?.data, {})
    if (!inventory[key]) inventory[key] = new Set()
    const paths = walkPaths(data)
    for (const p of paths) inventory[key].add(p)
  }

  const asJson = Object.fromEntries(
    Object.entries(inventory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, set]) => [k, Array.from(set).sort((a, b) => a.localeCompare(b))]),
  )

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(asJson, null, 2), 'utf8')
  console.log(`[profile-section-inventory] wrote ${outPath}`)
  console.log(`[profile-section-inventory] sections: ${Object.keys(asJson).length}`)
}

main()

