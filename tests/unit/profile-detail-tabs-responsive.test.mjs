import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
}

test('ProfileDetail: tabs list wraps into a responsive grid instead of a dead horizontal scrollbar', () => {
  const src = read('src/pages/ProfileDetail.jsx')
  const start = src.indexOf('<TabsList')
  assert.ok(start >= 0, 'TabsList not found')
  const snippet = src.slice(start, start + 600)

  assert.ok(snippet.includes('!grid'), 'TabsList should use a stable grid layout')
  assert.ok(snippet.includes('grid-cols-1'), 'TabsList should stack safely on narrow screens')
  assert.ok(snippet.includes('sm:grid-cols-2'), 'TabsList should wrap into two columns on small screens')
  assert.ok(snippet.includes('xl:grid-cols-4'), 'TabsList should spread into four columns on wide screens')
  assert.ok(!snippet.includes('overflow-x-auto'), 'TabsList should not depend on a horizontal scrollbar')
  assert.ok(!snippet.includes('whitespace-nowrap'), 'TabsList labels should be allowed to wrap instead of clipping')
})

