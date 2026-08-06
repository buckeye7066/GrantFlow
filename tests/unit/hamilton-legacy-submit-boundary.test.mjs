import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { draftGateLegacyAdapterResult } from '../../backend/services/hamiltonApplicationAgent.js'
import { ADAPTER_OUTCOMES } from '../../backend/services/portalAdapters/portalAdapterTypes.js'
import { runPortalSync } from '../../backend/services/hamilton/portalSync/index.js'

test('legacy Hamilton demotes adapter SUBMITTED claims to an evidence-safe draft', () => {
  const submitted = Object.freeze({
    outcome: ADAPTER_OUTCOMES.SUBMITTED,
    message: 'adapter claimed submission',
    requirements: [],
    filled_fields: { legal_name: 'Example' },
    submission_method: 'portal',
    submission_reference: 'external-reference',
    blocking_reason: null,
    safe_to_proceed: true,
  })

  const gated = draftGateLegacyAdapterResult(submitted)

  assert.notStrictEqual(gated, submitted)
  assert.equal(gated.outcome, ADAPTER_OUTCOMES.DRAFT_COMPLETED)
  assert.equal(gated.submission_method, null)
  assert.equal(gated.submission_reference, null)
  assert.equal(gated.blocking_reason, 'canonical_submission_required')
  assert.equal(gated.safe_to_proceed, false)
  assert.match(gated.message, /canonical Hamilton orchestrator/i)
  assert.equal(submitted.outcome, ADAPTER_OUTCOMES.SUBMITTED, 'input remains unchanged')
})

test('legacy Hamilton source has no external-submit or submitted-mirroring call site', () => {
  const source = readFileSync(
    new URL('../../backend/services/hamiltonApplicationAgent.js', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(source, /\badapter\.submitApplication\s*\(/)
  assert.doesNotMatch(source, /\bmarkSubmitted\b/)
  assert.match(source, /allowSubmit:\s*false/)
  assert.match(source, /draftGateLegacyAdapterResult\(result\)/)
})

test('portal sync cannot become a second final-submit authority', async () => {
  const result = await runPortalSync({}, {
    profileId: 'profile-demo',
    portalHost: 'portal.example.edu',
    direction: 'write',
    actorUserId: 'user-demo',
    allowSubmit: true,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'reviewed_submission_adapter_required')
  assert.equal(result.requires_human_submission, true)
  assert.equal(result.runId, null)
})
