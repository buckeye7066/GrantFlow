import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('TEST_DATABASE_URL=:memory: yields sqlite in-memory db and does not require filesystem', async () => {
  const prevEnv = { ...process.env }
  try {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: ':memory:',
      DB_PROVIDER: '', // ensure provider auto-detects
      DATABASE_URL: '', // no postgres
    })
    // Import a fresh copy of the module in its own context
    const mod = await import(`../db/index.js?mem=${Date.now()}`)
    const { db } = mod
    assert.equal(db.dialect, 'sqlite')
    // better-sqlite3 stores the filename on the wrapper as `path`
    assert.equal(typeof db.path, 'string')
    assert.equal(db.path, ':memory:')
  } finally {
    process.env = prevEnv
  }
})

test('TEST_DATABASE_URL=file:… path is honored for sqlite in test mode', async () => {
  const prevEnv = { ...process.env }
  try {
    const fileUrl = `file:${resolve(__dirname, `../../test-results/unit-sqlite-${Date.now()}.db`)}`
    Object.assign(process.env, {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: fileUrl,
      DB_PROVIDER: '',
      DATABASE_URL: '',
    })
    const mod = await import(`../db/index.js?file=${Date.now()}`)
    const { db } = mod
    assert.equal(db.dialect, 'sqlite')
    assert.equal(db.path, fileUrl)
  } finally {
    process.env = prevEnv
  }
})

