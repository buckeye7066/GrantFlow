import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ensureBillingAccount, ensureBillingSchema } from '../services/billingAccounts.js'

async function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE profiles (id TEXT PRIMARY KEY); INSERT INTO profiles VALUES ('p1')")
  await ensureBillingSchema(db)
  db.prepare("INSERT OR IGNORE INTO billing_tiers (id, name, base_monthly_cents) VALUES ('foundation', 'Foundation', 0)").run()
  return db
}

test('concurrent first billing reads return one account with one creation event', { timeout: 5000 }, async () => {
  const db = await fixture()
  let initialReads = 0
  let release
  const bothReadAbsent = new Promise(resolve => { release = resolve })
  const racing = {
    exec: sql => db.exec(sql),
    prepare: sql => {
      const statement = db.prepare(sql)
      if (!sql.includes('FROM billing_accounts ba')) return statement
      return {
        get: async (...params) => {
          const row = statement.get(...params)
          if (initialReads < 2) {
            assert.equal(row, undefined)
            initialReads += 1
            if (initialReads === 2) release()
            await bothReadAbsent
          }
          return row
        },
      }
    },
  }
  try {
    const results = await Promise.allSettled([
      ensureBillingAccount(racing, 'p1'),
      ensureBillingAccount(racing, 'p1'),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2,
      results.map(result => result.reason?.message ?? result.status).join('; '))
    const [first, second] = results.map(result => result.value)
    assert.equal(first.id, second.id)
    assert.equal(first.profile_id, 'p1')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_accounts').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_account_events').get().n, 1)
    assert.equal(db.prepare('SELECT account_id FROM billing_account_events').get().account_id, first.id)
  } finally {
    db.close()
  }
})

test('existing billing customization is never replaced by a default account', async () => {
  const db = await fixture()
  try {
    const created = await ensureBillingAccount(db, 'p1')
    db.prepare("UPDATE billing_accounts SET custom_monthly_cents = 12345, discount_percent = 15, assigned_by = 'owner', metadata = ? WHERE id = ?")
      .run('{"preserve":true}', created.id)
    const existing = await ensureBillingAccount(db, 'p1', { assignedBy: 'racing-default' })
    assert.equal(existing.id, created.id)
    assert.equal(existing.custom_monthly_cents, 12345)
    assert.equal(existing.discount_percent, 15)
    assert.equal(existing.assigned_by, 'owner')
    assert.equal(existing.metadata, '{"preserve":true}')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_account_events').get().n, 1)
  } finally {
    db.close()
  }
})

test('foreign-key failures remain errors, not fabricated billing access', async () => {
  const db = await fixture()
  try {
    await assert.rejects(ensureBillingAccount(db, 'missing-profile'), /FOREIGN KEY/i)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_accounts').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_account_events').get().n, 0)
  } finally {
    db.close()
  }
})
