import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
}

test('ProfileDetail: tabs list is scrollable (no grid overlap)', () => {
  const src = read('src/pages/ProfileDetail.jsx')
  const start = src.indexOf('<TabsList')
  assert.ok(start >= 0, 'TabsList not found')
  const snippet = src.slice(start, start + 600)

  assert.ok(snippet.includes('overflow-x-auto'), 'TabsList should be horizontally scrollable')
  assert.ok(snippet.includes('whitespace-nowrap'), 'TabsList should prevent wrapping/overlap')
  assert.ok(snippet.includes('shrink-0'), 'TabsTrigger should not shrink into overlap')
  assert.ok(!snippet.includes('grid-cols-'), 'TabsList should not use grid-cols-* for tab layout')
})

