import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

import { runNationalCrawlerV2 } from '../../../backend/services/nationalCrawlerV2/run.js'

function openDb() {
  const projectRoot = path.resolve(process.cwd())
  const dbPath = process.env.DATABASE_URL || path.join(projectRoot, 'backend', 'data', 'grantflow.db')
  if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Ensure schema is applied
  const schemaPath = path.join(projectRoot, 'backend', 'db', 'schema.sql')
  db.exec(fs.readFileSync(schemaPath, 'utf8'))
  return db
}

function isJsonArrayString(value) {
  try {
    const v = JSON.parse(value)
    return Array.isArray(v)
  } catch {
    return false
  }
}

test('crawler v2 smoke: produces normalized programs for both tracks without merging', async () => {
  const db = openDb()
  try {
    const result = await runNationalCrawlerV2({
      db,
      scopeMode: 'SMOKE_MODE',
      useLiveSources: false,
      maxSources: 10,
      maxUrlsPerSource: 2,
      timeoutSeconds: 10,
    })

    assert.ok(result.crawl_run_id)

    const runRow = db.prepare('SELECT * FROM crawl_runs WHERE crawl_run_id = ?').get(result.crawl_run_id)
    assert.equal(runRow.status, 'completed')
    assert.ok(runRow.sources_attempted >= 1)

    const a = db.prepare('SELECT * FROM nf_programs_a ORDER BY last_verified DESC LIMIT 20').all()
    const b = db.prepare('SELECT * FROM nf_programs_b ORDER BY last_verified DESC LIMIT 20').all()

    assert.ok(a.length >= 1, 'expected at least one TRACK_A program')
    assert.ok(b.length >= 1, 'expected at least one TRACK_B program (from mock or TN)')

    // Evidence: smoke run should include federal + state + county + tribal + mco coverage
    const distinctA = db.prepare('SELECT DISTINCT jurisdiction FROM nf_programs_a').all().map((r) => r.jurisdiction)
    const distinctB = db.prepare('SELECT DISTINCT jurisdiction FROM nf_programs_b').all().map((r) => r.jurisdiction)
    assert.ok(distinctA.includes('federal'), 'expected TRACK_A federal program in smoke run')
    assert.ok(distinctA.includes('state'), 'expected TRACK_A state program in smoke run')
    assert.ok(distinctA.includes('county'), 'expected TRACK_A county program in smoke run')
    assert.ok(distinctA.includes('tribal'), 'expected TRACK_A tribal program in smoke run')
    assert.ok(distinctB.includes('mco') || distinctB.includes('state'), 'expected TRACK_B mco (mock) or state provider program in smoke run')

    // Additional safety: Track A should never include MCO jurisdiction in our smoke set
    assert.ok(!distinctA.includes('mco'), 'TRACK_A should not include mco jurisdiction entries in smoke fixtures')

    // Track separation invariants
    a.forEach((row) => {
      assert.equal(row.funding_track, 'TRACK_A')
      assert.equal(row.provider_requirements, null)
      assert.ok(isJsonArrayString(row.eligible_population))
      assert.ok(isJsonArrayString(row.covered_services))
      assert.ok(row.program_id && typeof row.program_id === 'string' && row.program_id.length >= 32)
      assert.ok(row.source_url)
      assert.ok(row.last_verified)
    })

    b.forEach((row) => {
      assert.equal(row.funding_track, 'TRACK_B')
      assert.ok(isJsonArrayString(row.eligible_population))
      assert.ok(isJsonArrayString(row.covered_services))
      assert.ok(row.program_id && typeof row.program_id === 'string' && row.program_id.length >= 32)
      assert.ok(row.source_url)
      assert.ok(row.last_verified)
    })
  } finally {
    db.close()
  }
})

test('crawler v2 smoke: change detection creates a new version when content changes', async () => {
  const db = openDb()
  try {
    await runNationalCrawlerV2({
      db,
      scopeMode: 'SMOKE_MODE',
      useLiveSources: false,
      maxSources: 1,
      maxUrlsPerSource: 1,
      timeoutSeconds: 10,
    })

    // Ensure timestamps differ (SQLite CURRENT_TIMESTAMP is 1-second resolution)
    await new Promise((r) => setTimeout(r, 1100))

    const program = db
      .prepare(
        `
          SELECT program_id
          FROM nf_programs_a
          WHERE source_url LIKE ?
          ORDER BY last_verified DESC
          LIMIT 1
        `,
      )
      .get('%federal-ssa-benefits.html%')
    assert.ok(program?.program_id, 'expected a TRACK_A program_id to exist')

    const before = db
      .prepare(
        `
          SELECT version_id, content_hash, change_type, normalized_payload
          FROM nf_program_versions
          WHERE program_id = ? AND funding_track = 'TRACK_A'
          ORDER BY fetched_at DESC, created_at DESC, rowid DESC
          LIMIT 1
        `,
      )
      .get(program.program_id)
    assert.ok(before?.version_id, 'expected an initial version row')

    // Simulate content change by changing fixture file content
    const projectRoot = path.resolve(process.cwd())
    const fixturePath = path.join(projectRoot, 'tests', 'crawler', 'fixtures', 'federal-ssa-benefits.html')
    const original = fs.readFileSync(fixturePath, 'utf8')
    fs.writeFileSync(fixturePath, original.replace('Monthly cash benefit', 'Monthly cash benefit (updated)'), 'utf8')

    try {
      await runNationalCrawlerV2({
        db,
        scopeMode: 'SMOKE_MODE',
        useLiveSources: false,
        maxSources: 1,
        maxUrlsPerSource: 1,
        timeoutSeconds: 10,
      })
    } finally {
      // restore fixture
      fs.writeFileSync(fixturePath, original, 'utf8')
    }

    const after = db
      .prepare(
        `
          SELECT version_id, content_hash, change_type, normalized_payload
          FROM nf_program_versions
          WHERE program_id = ? AND funding_track = 'TRACK_A'
          ORDER BY fetched_at DESC, created_at DESC, rowid DESC
          LIMIT 1
        `,
      )
      .get(program.program_id)

    assert.ok(after?.version_id, 'expected a version row after content change')
    assert.notEqual(after.version_id, before.version_id, 'expected a new version id')
    assert.notEqual(after.content_hash, before.content_hash, 'expected content_hash to change')
    assert.ok(
      after.change_type === 'updated' || after.change_type === 'created',
      `expected change_type to be updated/created, got ${after.change_type}`,
    )
    assert.notEqual(after.normalized_payload, before.normalized_payload, 'expected normalized payload to change')
  } finally {
    db.close()
  }
})

