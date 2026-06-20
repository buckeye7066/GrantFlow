/**
 * Yana — enrichment requests (John → Yana back-channel).
 *
 * Verifies John can ask Yana for more on a thin lead, that re-asks are counted
 * (not duplicated), and that Yana servicing the request folds new facts back
 * into the candidate so the next draft can be specific.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  ensureYanaLeadSchema,
  makeYanaLeadSource,
  _resetYanaSchemaCache,
} from '../../backend/services/yana/yanaLeadDiscovery.js'
import {
  listOpenEnrichmentRequests,
  processEnrichmentRequests,
  _resetEnrichmentRequestSchemaCache,
} from '../../backend/services/yana/yanaEnrichmentRequests.js'
import {
  requestLeadEnrichment,
  getEnrichmentRequest,
} from '../../backend/services/john/johnYanaBridge.js'

function makeDb() {
  _resetYanaSchemaCache()
  _resetEnrichmentRequestSchemaCache()
  return new Database(':memory:')
}

async function insertThinCandidate(db, { id = 'cand-1', name = 'Jsl Education Foundation' } = {}) {
  await ensureYanaLeadSchema(db)
  db.prepare(
    `INSERT INTO yana_lead_candidates
       (id, organization_name, contact_email, public_evidence_json, source_urls_json,
        lead_score, contact_confidence, qualification_status, location)
     VALUES (?, ?, ?, '[]', '[]', 80, 60, 'qualified', 'Cleveland, OH')`,
  ).run(id, name, 'info@jsl.test')
  return id
}

test('John filing a request through the bridge stores one open request; re-asks bump attempts', async () => {
  const db = makeDb()
  try {
    const id = await insertThinCandidate(db)
    const src = makeYanaLeadSource(db)

    const first = await requestLeadEnrichment(src, {
      leadId: id,
      organizationName: 'Jsl Education Foundation',
      missing: ['mission_statement', 'website_excerpt'],
      note: 'too thin to personalize',
    })
    assert.equal(first.supported, true)
    assert.equal(first.attempts, 1)
    assert.equal(first.created, true)

    const second = await requestLeadEnrichment(src, {
      leadId: id,
      missing: ['named_contact'],
      note: 'still thin',
    })
    assert.equal(second.attempts, 2)
    assert.equal(second.created, false)

    const open = await listOpenEnrichmentRequests(db)
    assert.equal(open.length, 1, 'a re-ask must not create a duplicate row')
    assert.ok(open[0].missing.includes('mission_statement'))
    assert.ok(open[0].missing.includes('named_contact'))

    const req = await getEnrichmentRequest(src, id)
    assert.equal(req.attempts, 2)
  } finally {
    db.close()
  }
})

test('Yana servicing a request folds the new excerpt into the candidate and resolves it', async () => {
  const db = makeDb()
  try {
    const id = await insertThinCandidate(db)
    const src = makeYanaLeadSource(db)
    await src.requestEnrichment({ leadId: id, organizationName: 'Jsl Education Foundation', missing: ['website_excerpt'] })

    // Fake live enricher that finds a homepage + excerpt.
    const enricher = {
      enabled: true,
      async enrich() {
        return {
          ok: true,
          website_url: 'https://jsl.test',
          email: null,
          excerpt: 'JSL funds scholarships for first-generation college students across Ohio.',
        }
      },
    }
    const summary = await processEnrichmentRequests(db, { enricher })
    assert.equal(summary.resolved, 1)
    assert.equal(summary.unfulfilled, 0)

    const row = db.prepare(`SELECT * FROM yana_lead_candidates WHERE id = ?`).get(id)
    const evidence = JSON.parse(row.public_evidence_json)
    assert.ok(evidence.some((e) => e.type === 'website_excerpt' && /first-generation/.test(e.text)))
    assert.ok(JSON.parse(row.source_urls_json).includes('https://jsl.test'))

    const open = await listOpenEnrichmentRequests(db)
    assert.equal(open.length, 0, 'a serviced request must be closed')
  } finally {
    db.close()
  }
})

test('a disabled enricher closes the request as unfulfilled (John then drafts the best version)', async () => {
  const db = makeDb()
  try {
    const id = await insertThinCandidate(db)
    const src = makeYanaLeadSource(db)
    await src.requestEnrichment({ leadId: id, missing: ['website_excerpt'] })

    const summary = await processEnrichmentRequests(db, { enricher: { enabled: false } })
    assert.equal(summary.enabled, false)
    assert.equal(summary.unfulfilled, 1)
    assert.equal((await listOpenEnrichmentRequests(db)).length, 0)
  } finally {
    db.close()
  }
})

test('requestLeadEnrichment is a safe no-op for sources without the hook', async () => {
  const legacySource = {
    name: 'legacy',
    async listQualifiedLeads() { return [] },
    async markQueuedForReview() { return { ok: true } },
  }
  const r = await requestLeadEnrichment(legacySource, { leadId: 'x', missing: [] })
  assert.equal(r.ok, true)
  assert.equal(r.supported, false)
})
