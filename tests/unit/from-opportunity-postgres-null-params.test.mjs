import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('from-opportunity SQL avoids Postgres NULL-type inference trap', () => {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  const grantsPath = path.resolve(__dirname, '..', '..', 'backend', 'routes', 'grants.js')
  const src = fs.readFileSync(grantsPath, 'utf8')

  // In Postgres, a parameter used only in `IS NOT NULL` can remain "unknown" when null, causing:
  //   42P18: could not determine data type of parameter $N
  // Ensure we don't reintroduce the old pattern: `(? IS NOT NULL AND ...)`
  assert.equal(
    /\(\?\s+IS\s+NOT\s+NULL/i.test(src),
    false,
    `Found "(? IS NOT NULL" pattern in ${grantsPath}. This can cause Postgres 42P18 on null parameters.`,
  )
})

