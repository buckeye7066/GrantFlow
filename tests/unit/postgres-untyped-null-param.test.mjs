import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Postgres cannot infer a type for a bind parameter whose ONLY use is
// `IS NULL` / `IS NOT NULL`. `(? IS NULL OR col = ?)` therefore throws
// 42P18 "could not determine data type of parameter $N" for EVERY value,
// null or not. SQLite is untyped, so the in-memory test harness never sees it.
// Live incident 2026-09-11: GET /api/grants/:id answered 500 (42P18) for every
// caller on production. The typed spelling `CAST(? AS TEXT) IS NULL` works on
// both dialects. This guard scans every backend/shared source file.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const UNTYPED_NULL_PARAM = /\(\s*\?\s+IS\s+(?:NOT\s+)?NULL\b/i

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:js|mjs|cjs|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('no SQL uses a bare untyped bind parameter in IS [NOT] NULL (Postgres 42P18)', () => {
  const offenders = []
  for (const root of ['backend', 'shared']) {
    for (const file of walk(path.join(repoRoot, root))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (UNTYPED_NULL_PARAM.test(line)) offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(offenders, [], `Untyped "(? IS NULL" parameters fail on Postgres with 42P18; use CAST(? AS TEXT) IS NULL:\n${offenders.join('\n')}`)
})
