import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  const p = path.resolve(process.cwd(), relPath)
  return fs.readFileSync(p, 'utf8')
}

test('frontend API client methods exist in source', () => {
  const src = read('src/api/client.js')
  // We validate by source scan to avoid importing Vite-only `import.meta.env` in Node.
  assert.match(src, /\n\s*get\s*\(endpoint[,)]/m)
  assert.match(src, /\n\s*patch\s*\(endpoint[,)]/m)
  assert.match(src, /\n\s*post\s*\(endpoint[,)]/m)
  assert.match(src, /\n\s*put\s*\(endpoint[,)]/m)
  assert.match(src, /\n\s*delete\s*\(endpoint[,)]/m)
})

test('geo endpoints no longer hard-fail when zip dataset missing', () => {
  const src = read('backend/routes/admin.js')
  assert.ok(!src.includes('ZIP coordinate dataset missing'), 'admin.js still throws on missing zip dataset')
  assert.ok(src.includes("import zipcodes from 'zipcodes'"), 'admin.js should use zipcodes fallback')
})

test('uploads are configurable via UPLOADS_DIR', () => {
  const server = read('backend/server.js')
  const profiles = read('backend/routes/profiles.js')
  const uploadsPath = read('backend/utils/uploadsPath.js')
  assert.ok(server.includes('process.env.UPLOADS_DIR'), 'backend/server.js should honor UPLOADS_DIR')
  assert.ok(
    profiles.includes('resolveUploadsDir') || profiles.includes('getUploadsDir'),
    'backend/routes/profiles.js should honor UPLOADS_DIR via uploadsPath utility',
  )
  assert.ok(
    uploadsPath.includes('process.env.UPLOADS_DIR'),
    'backend/utils/uploadsPath.js should honor process.env.UPLOADS_DIR',
  )
})

test('crawler completion update does not use "CASE WHEN ? IS NULL" (breaks Postgres)', () => {
  const src = read('backend/services/crawlerDispatcher.js')
  assert.ok(
    !/CASE\s+WHEN\s+\?\s+IS\s+NULL/i.test(src),
    'crawlerDispatcher.js contains CASE WHEN ? IS NULL which can throw "could not determine data type of parameter $1" in Postgres',
  )
})
