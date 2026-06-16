import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeJohnDb,
} from './john-test-helpers.mjs'
import { insertDraft } from '../../backend/services/john/johnRunStore.js'
import {
  checkRateGate,
  computeRunBudget,
  getDraftCapacity,
} from '../../backend/services/john/johnRateLimiter.js'
import { getJohnConfig } from '../../backend/services/john/johnOutreachSafety.js'
import { BLOCK_REASONS, DRAFT_STATUS } from '../../backend/services/john/johnTypes.js'

let SEED_COUNTER = 0
async function seedDrafts(db, n, { offsetMs = 0, status = DRAFT_STATUS.CREATED } = {}) {
  const created = new Date(Date.now() - offsetMs).toISOString()
  for (let i = 0; i < n; i++) {
    SEED_COUNTER += 1
    const id = `seed-${SEED_COUNTER}-${Math.random().toString(36).slice(2, 8)}`
    db._raw.prepare(`
      INSERT INTO john_email_drafts (id, draft_status, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, status, created, created)
  }
}

test('getDraftCapacity counts only non-blocked drafts in the rolling window', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    // 5 created drafts in last 24h, 2 blocked drafts (which should not count),
    // and 3 created drafts older than 24h (should not count).
    await seedDrafts(db, 5, { offsetMs: 60_000 })
    await seedDrafts(db, 2, { offsetMs: 60_000, status: DRAFT_STATUS.BLOCKED })
    await seedDrafts(db, 3, { offsetMs: 25 * 60 * 60 * 1000 })
    const cap = await getDraftCapacity(db, getJohnConfig())
    assert.equal(cap.counts.created_last_24h, 5)
    assert.equal(cap.remaining.remaining_24h, 50 - 5)
  } finally {
    restore()
    db.close()
  }
})

test('computeRunBudget collapses to remaining-24h when daily cap is the smallest', async () => {
  const restore = applyEnv({
    JOHN_MAX_DRAFTS_PER_24H: '50',
    JOHN_MAX_DRAFTS_PER_HOUR: '10',
    JOHN_MAX_DRAFTS_PER_RUN: '50',
  })
  const db = makeJohnDb()
  try {
    // 47 drafts last 24h (placed >1h ago so hourly cap isn't the bottleneck)
    // → only 3 remaining for the day.
    await seedDrafts(db, 47, { offsetMs: 5 * 60 * 60 * 1000 })
    const budget = await computeRunBudget(db, { config: getJohnConfig() })
    assert.equal(budget.budget, 3, 'budget collapses to remaining-24h')

    // Caller-requested 0 forces 0.
    const budget0 = await computeRunBudget(db, { requested: 0, config: getJohnConfig() })
    assert.equal(budget0.budget, 0)
  } finally {
    restore()
    db.close()
  }
})

test('computeRunBudget collapses to remaining-hour when hourly cap is the smallest', async () => {
  const restore = applyEnv({
    JOHN_MAX_DRAFTS_PER_24H: '50',
    JOHN_MAX_DRAFTS_PER_HOUR: '10',
    JOHN_MAX_DRAFTS_PER_RUN: '50',
  })
  const db = makeJohnDb()
  try {
    await seedDrafts(db, 9, { offsetMs: 30 * 1000 })
    const budget = await computeRunBudget(db, { config: getJohnConfig() })
    assert.equal(budget.budget, 1, 'hourly cap dominates: 10 - 9 = 1')
  } finally {
    restore()
    db.close()
  }
})

test('checkRateGate returns DAILY_LIMIT_REACHED at 50/24h', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await seedDrafts(db, 50, { offsetMs: 4 * 60 * 60 * 1000 })
    const gate = await checkRateGate(db, getJohnConfig())
    assert.equal(gate.ok, false)
    assert.ok(gate.reasons.includes(BLOCK_REASONS.DAILY_LIMIT_REACHED))
  } finally {
    restore()
    db.close()
  }
})

test('John never creates draft #51 when the cap is 50', async () => {
  // Direct end-to-end against insertDraft + the rate gate: simulate the agent
  // loop by checking the gate before each insert.
  const restore = applyEnv({
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'true',
    JOHN_ALLOW_SEND: 'false',
    JOHN_MAX_DRAFTS_PER_24H: '50',
    JOHN_MAX_DRAFTS_PER_RUN: '50',
    JOHN_MAX_DRAFTS_PER_HOUR: '50',
    JOHN_PHYSICAL_ADDRESS_REQUIRED: 'false',
  })
  const db = makeJohnDb()
  try {
    let created = 0
    for (let i = 0; i < 60; i++) {
      const gate = await checkRateGate(db, getJohnConfig())
      if (!gate.ok) break
      await insertDraft(db, {
        id: `t-${i}`,
        draft_status: DRAFT_STATUS.CREATED,
        organization_name: `Org ${i}`,
        recipient_email: `o${i}@example.org`,
        subject: 'Possible funding help for Org',
        body_text: 'Hi.',
      })
      created += 1
    }
    assert.equal(created, 50, 'rate limiter must stop at 50 in a 24-hour window')
  } finally {
    restore()
    db.close()
  }
})
