import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// GET /api/grants applies validatePagination: no `limit` means a DEFAULT page of
// 100 rows (backend/config/constants.js), returned as a bare array with no
// pagination metadata. Production 2026-09-11: Reports & Analytics called
// client.entities.Grant.list() with no limit, received 91 rows (1 submitted,
// 0 awarded) and reported Total Awarded 0 / Success Rate 0.0% while the
// Pipeline (limit 2000 -> clamped 1000) showed 125 grants, 17 submitted and an
// award of 118,500. Every frontend consumer of the grants list must ask for the
// full set explicitly.
const root = new URL('../../', import.meta.url)
const srcDir = new URL('src/', root)

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      out.push(...walk(full))
    } else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

test('no frontend caller reads the grants list without an explicit limit', () => {
  const offenders = []
  // Grant.list() or Grant.list('<sort>') with no second (limit) argument.
  const noLimit = /Grant\.list\(\s*(?:(['"`])[^'"`]*\1\s*)?\)/g
  for (const file of walk(srcDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(noLimit)) {
      const line = text.slice(0, match.index).split('\n').length
      offenders.push(`${path.relative(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file)}:${line} ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [], `Grant.list() without a limit gets a silent 100-row page:\n${offenders.join('\n')}`)
})

test('no frontend GET of /api/grants omits a limit', () => {
  const offenders = []
  // apiFetch('/api/grants') or apiFetch('/api/grants', {...}) with no query string.
  const bare = /apiFetch\(\s*(['"`])\/api\/grants\1\s*([,)])/g
  for (const file of walk(srcDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(bare)) {
      const tail = text.slice(match.index, match.index + 200)
      if (/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(tail)) continue
      const line = text.slice(0, match.index).split('\n').length
      offenders.push(`${path.relative(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file)}:${line}`)
    }
  }
  assert.deepEqual(offenders, [], `GET /api/grants without a limit gets a silent 100-row page:\n${offenders.join('\n')}`)
})
