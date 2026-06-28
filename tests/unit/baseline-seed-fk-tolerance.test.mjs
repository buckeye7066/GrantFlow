import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { seedBaselineFromRepo } from '../../backend/utils/seedBaselineFromRepo.js'

async function createDbWrapper(dbFilePath) {
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(dbFilePath)
  raw.pragma('foreign_keys = ON')

  const wrapper = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    exec(sql) {
      return raw.exec(sql)
    },
    async withTransaction(fn) {
      raw.exec('BEGIN')
      try {
        const tx = {
          dialect: 'sqlite',
          prepare: (sql) => {
            const stmt = raw.prepare(sql)
            return {
              get: (...args) => stmt.get(...args),
              all: (...args) => stmt.all(...args),
              run: (...args) => stmt.run(...args),
            }
          },
          exec: (sql) => raw.exec(sql),
        }
        const result = await fn(tx)
        raw.exec('COMMIT')
        return result
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // ignore
        }
        throw error
      }
    },
    close() {
      raw.close()
    },
  }

  return wrapper
}

test('baseline seed: source-safe empty grant fixture does not hard-fail', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-baseline-seed-'))
  const dbPath = path.join(tmp, 'test.db')

  const db = await createDbWrapper(dbPath)
  try {
    // Apply core schema (includes FK constraints).
    const schema = readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
    db.exec(schema)

    // Create an existing opportunity so `before.opportunities !== 0` and baseline seeding will NOT seed opportunities.
    // (This reproduces the production/local state where opportunities exist, but seed grant links may not.)
    db.prepare(
      `
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, is_active, updated_at
        ) VALUES (
          'existing-opp', 'Existing Opportunity', 'Existing Sponsor', 'manual', 1, CURRENT_TIMESTAMP
        )
      `,
    ).run()

    const result = await seedBaselineFromRepo(db, {
      mode: 'auto',
      seedOpportunitiesIfEmpty: true, // should be skipped due to 1 existing opp
      seedGrantsIfEmpty: true, // should run (empty grants)
      seedDocumentsIfEmpty: false, // keep test focused
    })

    assert.equal(result.ok, true)
    assert.equal(result.skipped, false)

    assert.equal(result.decisions.grants, true)
    assert.equal(result.counts.grants_upserted, 0)

    const grantsCount = Number((await db.prepare('SELECT COUNT(*) as count FROM grants').get())?.count || 0)
    assert.equal(grantsCount, 0, 'source-safe public baseline should not reintroduce funding-source traces')
  } finally {
    db.close()
  }
})
