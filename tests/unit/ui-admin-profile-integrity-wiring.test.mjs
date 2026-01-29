import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('Admin profile integrity UI calls correct backend endpoints', async () => {
  const filePath = path.resolve('src/components/admin/AdminProfileIntegrity.jsx')
  assert.ok(fs.existsSync(filePath), `expected ${filePath} to exist`)

  const content = fs.readFileSync(filePath, 'utf8')

  // Report endpoint
  assert.ok(
    content.includes('/api/admin/profiles/integrity'),
    'expected AdminProfileIntegrity to reference /api/admin/profiles/integrity',
  )

  // Repair endpoint
  assert.ok(
    content.includes('/api/admin/profiles/integrity/repair'),
    'expected AdminProfileIntegrity to reference /api/admin/profiles/integrity/repair',
  )
})

