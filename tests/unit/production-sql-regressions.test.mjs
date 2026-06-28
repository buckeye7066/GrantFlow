import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function readRepoFile(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

test('project readiness document query selects created_at before ordering by it', () => {
  const src = readRepoFile('backend/routes/profiles.js')
  const query = src.match(/SELECT DISTINCT d\.id[\s\S]+?ORDER BY d\.created_at DESC/)?.[0] || ''
  const selectList = query.split('FROM documents d')[0] || ''
  assert.ok(query, 'project readiness document SELECT DISTINCT query should be present')
  assert.match(selectList, /d\.created_at/, 'Postgres requires ORDER BY columns in SELECT DISTINCT list')
})

test('login announcements use a dialect-specific boolean predicate', () => {
  const src = readRepoFile('backend/routes/announcements.js')
  assert.match(src, /activePredicate\s*=\s*req\.db\?\.dialect === 'postgres' \? 'active IS TRUE' : 'active = 1'/)
  assert.doesNotMatch(
    src,
    /WHERE\s+active\s*=\s*1/,
    'Postgres boolean columns must not be compared to integer 1',
  )
})

test('auth bootstrap does not order a SELECT DISTINCT result by an unselected column', () => {
  const src = readRepoFile('backend/server.js')
  const query = src.match(/SELECT DISTINCT p\.id, p\.display_name, p\.organization_id, p\.status[\s\S]+?ORDER BY p\.[a-z_]+ ASC/)?.[0] || ''
  const selectList = query.split('FROM profiles p')[0] || ''
  assert.ok(query, 'auth bootstrap DISTINCT profile query should be present')
  assert.match(selectList, /p\.created_at/, 'Postgres requires ORDER BY columns in SELECT DISTINCT list')
})
