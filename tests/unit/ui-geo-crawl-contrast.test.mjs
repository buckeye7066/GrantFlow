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

  // The retired primary action remains visually explicit and readable.
  assert.ok(src.includes('Crawl start retired'), 'retired crawl status is missing')
  assert.ok(src.includes('disabled={GEO_CRAWL_START_RETIRED}'), 'retired crawl control must remain disabled')
  assert.ok(
    src.includes('bg-blue-600') && src.includes('text-white'),
    'retired crawl status should retain high-contrast styling',
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
