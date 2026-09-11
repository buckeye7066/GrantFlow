import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Production 2026-09-11: Pricing "Get Started" was createPageUrl(cond ?
// 'CreateProfile' : 'Organizations'); /CreateProfile is not a route, so the
// click rendered blank chrome. Every page name passed to createPageUrl (including
// ternary branches) must be a registered route.
const root = new URL('../../', import.meta.url)
const rootPath = root.pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (relative) => fs.readFileSync(path.join(rootPath, relative), 'utf8')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function argumentSpan(text, start) {
  let depth = 0
  for (let i = start; i < text.length && i < start + 600; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return text.slice(start + 1, i) }
  }
  return text.slice(start + 1, start + 600)
}

test('every createPageUrl page name is a registered route', () => {
  const routeNames = new Set([...read('src/pages/routeNames.js').matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]))
  const router = read('src/pages/index.jsx')
  for (const m of router.matchAll(/path="\/([A-Za-z][A-Za-z-]*)/g)) routeNames.add(m[1])
  const offenders = []
  for (const file of walk(path.join(rootPath, 'src'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/createPageUrl\s*\(/g)) {
      const open = m.index + m[0].length - 1
      const args = argumentSpan(text, open)
      // Page names are the quoted identifiers in the FIRST argument (before a
      // top-level comma), including ternary branches.
      let depth = 0, cut = args.length
      for (let i = 0; i < args.length; i++) {
        const ch = args[i]
        if ('({['.includes(ch)) depth++
        else if (')}]'.includes(ch)) depth--
        else if (ch === ',' && depth === 0) { cut = i; break }
      }
      for (const q of args.slice(0, cut).matchAll(/['"`]([A-Z][A-Za-z]+)['"`]/g)) {
        if (!routeNames.has(q[1])) {
          const line = text.slice(0, m.index).split('\n').length
          offenders.push(`${path.relative(rootPath, file)}:${line} ${q[1]}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `createPageUrl targets that are not routes:\n${offenders.join('\n')}`)
})
