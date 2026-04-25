/**
 * Real button/handler scanner for admin.anya.testButtons.
 *
 * This module replaces the previous "recommendations" stub. It:
 *   1. Walks src/components/** for .jsx/.tsx files.
 *   2. Extracts elements that represent clickable UI (Button/<button>/IconButton/Link)
 *      together with their onClick/onSubmit handler reference.
 *   3. Resolves each handler to (a) an inline body, or (b) a named function
 *      in the same file.
 *   4. Scans the handler body for HTTP endpoint calls (`fetch(...)`,
 *      `api.get/post/...`, `axios.get/...`, and raw `/api/...` string literals).
 *   5. Returns a structured report of buttons, their handlers, and detected
 *      endpoints that downstream code can probe with supertest.
 *
 * The parser is intentionally regex-based. A full Babel AST is overkill for
 * the auditor use-case: we only need a best-effort mapping of UI actions to
 * API endpoints so operators can answer "which buttons are wired to dead
 * endpoints?" without installing a transpiler. Unparseable files fall
 * through as inconclusive rather than throwing.
 */

import path from 'path'
import { promises as fs } from 'fs'

const DEFAULT_ROOT = path.resolve(process.cwd(), 'src', 'components')

const EXTS = new Set(['.jsx', '.tsx', '.js', '.mjs'])

const BUTTON_TAGS = new Set([
  'button',
  'Button',
  'IconButton',
  'MenuButton',
  'SubmitButton',
  'LinkButton',
  'CommandButton',
  'ToggleButton',
])

export async function collectComponentFiles(root) {
  const base = path.resolve(root || DEFAULT_ROOT)
  const out = []
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      /* intentionally ignored: missing or unreadable dir — skip */
      return
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (EXTS.has(path.extname(ent.name))) {
        out.push(full)
      }
    }
  }
  await walk(base)
  return out
}

/**
 * Parse one component file and return the list of clickable elements with
 * the handler expression they reference.
 */
export function extractButtons(source) {
  const results = []
  // JSX attributes can contain arrow functions with `>` characters
  // (e.g. `onClick={() => foo}`). A simple `[^>]*?>` pattern would be
  // truncated by those. Walk the source manually and use brace balance
  // to find the real end of each opening tag.
  const tagStartRx = /<([A-Za-z][A-Za-z0-9]*)\b/g
  let m
  while ((m = tagStartRx.exec(source))) {
    const tag = m[1]
    if (!BUTTON_TAGS.has(tag)) continue
    const attrsStart = m.index + m[0].length
    const endIdx = findTagEnd(source, attrsStart)
    if (endIdx === -1) continue
    const attrs = source.slice(attrsStart, endIdx)
    const handler = extractHandlerRef(attrs, ['onClick', 'onPress', 'onSubmit'])
    if (!handler) continue
    const label = extractLabel(source, endIdx)
    results.push({
      tag,
      handlerRef: handler,
      label,
      lineIndex: source.slice(0, m.index).split('\n').length,
    })
  }
  return results
}

function findTagEnd(source, from) {
  let depth = 0
  let inString = null
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

function extractHandlerRef(attrs, attrNames) {
  for (const name of attrNames) {
    const rx = new RegExp(`${name}\\s*=\\s*\\{`, 'g')
    const hit = rx.exec(attrs)
    if (!hit) continue
    const start = hit.index + hit[0].length
    const expr = readBalanced(attrs, start - 1) // include opening {
    if (expr) return { attr: name, expr: expr.trim() }
  }
  return null
}

function readBalanced(text, openIdx) {
  if (text[openIdx] !== '{') return null
  let depth = 0
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIdx + 1, i)
    }
  }
  return null
}

function extractLabel(source, tagEnd) {
  // tagEnd is the index of the closing `>` of the opening tag.
  const end = source.indexOf('<', tagEnd + 1)
  if (end === -1) return null
  const raw = source.slice(tagEnd + 1, end).trim()
  if (!raw) return null
  return raw.replace(/\s+/g, ' ').slice(0, 80)
}

/**
 * Given a handler expression (either inline or an identifier) and the full
 * source file, return the text of the handler body we should scan for
 * endpoint calls.
 */
export function resolveHandlerBody(handlerExpr, source) {
  const expr = handlerExpr.trim()
  if (/^\(?\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/.test(expr) || /^\s*(async\s+)?function\b/.test(expr)) {
    return { kind: 'inline', body: expr }
  }
  // Strip optional chaining suffixes like handler?.()
  const ident = expr.replace(/\s*\(.*$/s, '').replace(/\?\.$/, '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return { kind: 'unresolved', body: expr }
  }
  const fnRx = new RegExp(
    `(?:const|let|var)\\s+${ident}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[^=]+?)=>\\s*\\{|function\\s+${ident}\\s*\\([^)]*\\)\\s*\\{`,
    'm',
  )
  const match = fnRx.exec(source)
  if (!match) return { kind: 'identifier', name: ident, body: null }
  const braceIdx = source.indexOf('{', match.index + match[0].length - 1)
  if (braceIdx === -1) return { kind: 'identifier', name: ident, body: null }
  const body = readBalanced(source, braceIdx)
  return { kind: 'identifier', name: ident, body: body ?? null }
}

/**
 * Extract HTTP endpoints referenced inside a handler body.
 * We capture:
 *   fetch(`/api/...`)
 *   axios.get('/api/...')
 *   api.post('/foo/bar', ...)
 *   '/api/...'          (bare literal)
 */
export function extractEndpoints(body) {
  if (!body) return []
  const endpoints = []
  const push = (method, url) => {
    if (!url) return
    if (!/^\/?api\//i.test(url) && !url.startsWith('/api/')) {
      if (!url.startsWith('/')) return
    }
    endpoints.push({ method: method.toUpperCase(), url })
  }
  // fetch('/api/...', { method: 'POST' })
  const fetchRx = /fetch\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([^}]*)\})?/g
  let m
  while ((m = fetchRx.exec(body))) {
    const method = /method\s*:\s*['"]([A-Z]+)['"]/i.exec(m[3] || '')?.[1] || 'GET'
    push(method, m[2])
  }
  // axios.get / api.post / apiClient.put ...
  const dottedRx = /\b(?:axios|api|apiClient|http|client)\.(get|post|put|patch|delete|head)\s*\(\s*(['"`])([^'"`]+)\2/gi
  while ((m = dottedRx.exec(body))) {
    push(m[1], m[3])
  }
  // Bare string literals of the form '/api/...'
  const bareRx = /(['"`])(\/api\/[A-Za-z0-9_\-./:?=&]+)\1/g
  while ((m = bareRx.exec(body))) {
    push('GET', m[2])
  }
  // Dedup on method+url
  const seen = new Set()
  return endpoints.filter((e) => {
    const key = `${e.method} ${e.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function scanComponentForButtons(file) {
  let source
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (err) {
    return { file, error: err?.message || String(err), buttons: [] }
  }
  const buttons = extractButtons(source)
  const enriched = buttons.map((btn) => {
    const handler = resolveHandlerBody(btn.handlerRef.expr, source)
    const endpoints = extractEndpoints(handler.body || btn.handlerRef.expr)
    return {
      ...btn,
      handler: {
        kind: handler.kind,
        name: handler.name ?? null,
        has_body: Boolean(handler.body),
      },
      endpoints,
    }
  })
  return { file, buttons: enriched }
}
