import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('admin geo crawl: primary/secondary actions have explicit contrast classes', () => {
  const src = read('src/components/admin/AdminGeoCrawl.jsx')

  // Primary action should be visually distinct and readable
  assert.ok(src.includes('Start crawl'), 'Start crawl button missing')
  assert.ok(
    src.includes('bg-blue-600') && src.includes('text-white'),
    'Start crawl should use high-contrast blue background with white text',
  )

  // Secondary action should be distinct from primary
  assert.ok(src.includes('Index counties'), 'Index counties button missing')
  assert.ok(
    src.includes("variant=\"secondary\"") || src.includes("variant='secondary'"),
    'Index counties should use a secondary/outline-like variant',
  )

  // Inputs should have visible focus ring
  assert.ok(
    src.includes('focus-visible:ring-2') && src.includes('focus-visible:ring-blue-500'),
    'Inputs/SelectTrigger should have visible focus ring on dark containers',
  )
})

