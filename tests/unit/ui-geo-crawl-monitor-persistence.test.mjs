import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('admin geo crawl: monitor persists last run id across refresh', () => {
  const admin = read('src/components/admin/AdminGeoCrawl.jsx')
  assert.ok(admin.includes('gf_geo_crawl_last_run_id_v2'), 'localStorage key missing')
  assert.ok(admin.includes('localStorage.getItem'), 'should restore last run id on mount')
  assert.ok(admin.includes('localStorage.setItem'), 'should persist last run id when starting crawl')
  assert.ok(admin.includes('onStaleRun'), 'should clear stale run id when monitor dismisses after 404')

  const monitor = read('src/components/admin/GeoCrawlMonitor.jsx')
  assert.ok(monitor.includes('suspendPolling'), 'should stop polling when run is missing (404)')
  assert.ok(monitor.includes('Dismiss monitor'), 'should offer dismiss when run is gone')
})

