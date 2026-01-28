import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('admin geo crawl: monitor persists last run id across refresh', () => {
  const src = read('src/components/admin/AdminGeoCrawl.jsx')
  assert.ok(src.includes('gf_geo_crawl_last_run_id'), 'localStorage key missing')
  assert.ok(src.includes('localStorage.getItem'), 'should restore last run id on mount')
  assert.ok(src.includes('localStorage.setItem'), 'should persist last run id when starting crawl')
})

