import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gateScript = path.join(repoRoot, 'scripts', 'verify-stability.mjs')
const schemaSql = fs.readFileSync(path.join(repoRoot, 'backend', 'db', 'schema.sql'), 'utf8')

function runGate(sqlitePath, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gateScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SQLITE_DB_PATH: sqlitePath,
        DB_AUTO_MIGRATE: '0',
        MIGRATE_ON_BOOT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      reject(new Error(`verify-stability.mjs did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

// `scripts/verify-stability.mjs` is a registered Sam PRODUCTION GATE
// (`PRODUCTION_GATE_NODE_SCRIPTS`), and `samAgent.formatGate` derives its
// verdict PURELY from the exit code — nothing reads stdout. It used to print
// every failure as a `❌` line and then `process.exit(0)` unconditionally, so
// a database missing every required table was recorded as `passed`.
//
// This test exercises the FAILURE mode, which is the only thing that proves a
// gate is a gate. A gate that cannot fail is not a check.
test('verify-stability FAILS (exit 1) when the database is missing its required tables', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-verify-stability-'))
  const dbPath = path.join(dir, 'empty.db')
  try {
    const { code, stdout } = await runGate(dbPath)
    assert.equal(
      code,
      1,
      `expected a non-zero exit for an empty database; the gate is unfailable otherwise.\n${stdout}`,
    )
    assert.match(stdout, /FAILED: \d+ critical stability check\(s\) did not pass\./)
    assert.match(stdout, /required table users is missing or unreadable/)
    assert.doesNotMatch(stdout, /All critical stability checks passed\./)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The list named `opportunities`, a table that has never existed in this
// schema (the canonical catalog table is `funding_opportunities`). Because the
// gate could not fail, that stale entry printed a `❌` on every run against a
// perfectly healthy database and was still reported as `passed`. Now that the
// exit code means something, a stale entry would red the gate permanently —
// so pin the list to tables the schema actually declares.
test('every table verify-stability requires is actually declared in schema.sql', () => {
  const source = fs.readFileSync(gateScript, 'utf8')
  const block = source.match(/const requiredTables = \[([\s\S]*?)\]/)
  assert.ok(block, 'could not locate the requiredTables list in verify-stability.mjs')
  const tables = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(tables.length >= 5, `expected a real requiredTables list, got ${tables.length} entries`)
  for (const table of tables) {
    assert.match(
      schemaSql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'),
      `verify-stability requires table "${table}", which schema.sql does not declare`,
    )
  }
})
