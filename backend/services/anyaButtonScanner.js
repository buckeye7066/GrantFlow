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
 * Extraction is JSX-aware via @babel/parser so modern shadcn/Tailwind
 * formatting, multiline attributes, and non-button click targets do not get
 * missed by brittle tag regexes. Unparseable files fall through as
 * inconclusive rather than throwing.
 */

import path from 'path'
import { promises as fs } from 'fs'
import { parse } from '@babel/parser'

const DEFAULT_ROOT = path.resolve(process.cwd(), 'src', 'components')

const EXTS = new Set(['.jsx', '.tsx', '.js', '.mjs'])

const BUTTON_TAGS = new Set([
  'button',
  'Button',
  'ButtonPrimitive',
  'IconButton',
  'MenuButton',
  'SubmitButton',
  'LinkButton',
  'CommandButton',
  'ToggleButton',
  'DropdownMenuItem',
  'CommandItem',
  'TabsTrigger',
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
  const parseOptions = {
      sourceType: 'module',
      errorRecovery: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'objectRestSpread', 'optionalChaining'],
  }
  let ast
  let parseSource = source
  try {
    ast = parse(parseSource, parseOptions)
  } catch {
    try {
      parseSource = `<>${source}</>`
      ast = parse(parseSource, parseOptions)
    } catch {
      return results
    }
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'JSXElement') collectJsxElement(node, parseSource, results)

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      if (Array.isArray(value)) {
        for (const child of value) visit(child)
      } else if (value && typeof value === 'object') {
        visit(value)
      }
    }
  }

  visit(ast)
  return results
}

function collectJsxElement(node, source, results) {
  const opening = node.openingElement
  if (!opening) return

  const tag = jsxNameToString(opening.name)
  const localTag = tag.split('.').pop()
  const attrs = opening.attributes || []
  const handler = extractJsxHandler(attrs, source, ['onClick', 'onPress', 'onSubmit'])
  const role = extractJsxAttributeValue(attrs, source, 'role')
  const type = extractJsxAttributeValue(attrs, source, 'type')
  const isButtonLike =
    BUTTON_TAGS.has(localTag) ||
    role === 'button' ||
    type === 'button' ||
    Boolean(handler)

  if (!isButtonLike || !handler) return

  results.push({
    tag,
    handlerRef: handler,
    label: extractJsxLabel(node, source),
    lineIndex: opening.loc?.start?.line ?? 1,
  })
}

function jsxNameToString(name) {
  if (!name) return ''
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') {
    return `${jsxNameToString(name.object)}.${jsxNameToString(name.property)}`
  }
  if (name.type === 'JSXNamespacedName') {
    return `${jsxNameToString(name.namespace)}:${jsxNameToString(name.name)}`
  }
  return ''
}

function extractJsxHandler(attrs, source, attrNames) {
  for (const name of attrNames) {
    const attr = attrs.find((candidate) =>
      candidate?.type === 'JSXAttribute' &&
      candidate.name?.type === 'JSXIdentifier' &&
      candidate.name.name === name
    )
    if (!attr) continue
    const expr = jsxAttributeExpression(attr, source)
    if (expr) return { attr: name, expr: expr.trim() }
  }
  return null
}

function extractJsxAttributeValue(attrs, source, name) {
  const attr = attrs.find((candidate) =>
    candidate?.type === 'JSXAttribute' &&
    candidate.name?.type === 'JSXIdentifier' &&
    candidate.name.name === name
  )
  if (!attr) return null
  const value = attr.value
  if (!value) return true
  if (value.type === 'StringLiteral') return String(value.value || '').toLowerCase()
  if (value.type === 'JSXExpressionContainer') {
    const expr = jsxAttributeExpression(attr, source)
    return String(expr || '').replace(/^['"`]|['"`]$/g, '').toLowerCase()
  }
  return null
}

function jsxAttributeExpression(attr, source) {
  const value = attr.value
  if (!value) return null
  if (value.type === 'StringLiteral') return value.value
  if (value.type === 'JSXExpressionContainer' && value.expression) {
    return source.slice(value.expression.start, value.expression.end)
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

function extractJsxLabel(node, source) {
  const parts = []
  for (const child of node.children || []) {
    if (child.type === 'JSXText') {
      const text = child.value.replace(/\s+/g, ' ').trim()
      if (text) parts.push(text)
    } else if (child.type === 'JSXExpressionContainer' && child.expression) {
      const expr = source.slice(child.expression.start, child.expression.end).replace(/\s+/g, ' ').trim()
      if (expr) parts.push(`{${expr}}`)
    } else if (child.type === 'JSXElement') {
      const tag = jsxNameToString(child.openingElement?.name)
      if (tag) parts.push(`<${tag}>`)
    }
  }
  const label = parts.join(' ').trim()
  return label ? label.slice(0, 80) : null
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
