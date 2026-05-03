/**
 * profileSectionPrompt.test.mjs
 *
 * Regression guard for the 500s on POST /api/profiles/:id/sections/:sectionKey/ai
 * across every section (basic_information, financial_information, … narrative).
 *
 * Root cause: `req.db.prepare(sql).all(id)` returns a Promise on PostgresTx but
 * was passed un-awaited into `buildProfileSectionPrompt`, which then called
 * `documents.slice(0, 8)` on the Promise and threw "documents.slice is not a
 * function" — bubbling out of the inner try/catch into the outer 500 handler.
 *
 * Fix is in two places:
 *   1) backend/routes/profiles.js: await the docs query and coerce to array.
 *   2) backend/prompts/profileSections.js: defensively coerce `documents` to []
 *      so a future regression cannot 500 the AI flow.
 *
 * This test exercises (2) directly so the fix can never silently regress.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProfileSectionPrompt,
  supportedSectionKeys,
} from '../../backend/prompts/profileSections.js'

const baseProfile = { id: 'p-test', display_name: 'Test Profile', primary_type: 'individual_need' }
const baseSections = {
  basic_information: { full_name: 'Test Profile' },
  housing: { geographic_designation: ['rural'] },
  programs_services: { keywords: ['workforce'] },
}

test('buildProfileSectionPrompt: documents = undefined is tolerated', () => {
  const out = buildProfileSectionPrompt('basic_information', {
    profile: baseProfile,
    sections: baseSections,
    documents: undefined,
  })
  assert.ok(out && typeof out.prompt === 'string', 'prompt should be a string')
  assert.ok(out.prompt.length > 0)
})

test('buildProfileSectionPrompt: documents = null is tolerated', () => {
  const out = buildProfileSectionPrompt('financial_information', {
    profile: baseProfile,
    sections: baseSections,
    documents: null,
  })
  assert.ok(out && typeof out.prompt === 'string')
})

test('buildProfileSectionPrompt: documents = pg-shaped { rows: [...] } is tolerated', () => {
  const out = buildProfileSectionPrompt('housing', {
    profile: baseProfile,
    sections: baseSections,
    documents: { rows: [{ id: 'd1', name: 'doc.pdf', type: 'pdf', status: 'ready', notes: '' }] },
  })
  assert.ok(out && typeof out.prompt === 'string')
  assert.ok(out.prompt.includes('doc.pdf'), 'document name should make it into the prompt')
})

test('buildProfileSectionPrompt: documents = unawaited Promise<[]> does NOT throw (defensive)', async () => {
  // This is the exact failure mode that caused production 500s. The builder
  // must NOT throw even if a caller forgets to await — instead, drop docs.
  const docsPromise = Promise.resolve([{ id: 'd1', name: 'late.pdf', type: 'pdf', status: 'ready', notes: '' }])
  const out = buildProfileSectionPrompt('narrative', {
    profile: baseProfile,
    sections: baseSections,
    documents: docsPromise,
  })
  assert.ok(out && typeof out.prompt === 'string', 'prompt should be a string even when documents is a Promise')
  // Promise has no .slice/.rows, so the prompt should simply omit the docs section.
  assert.ok(!out.prompt.includes('late.pdf'), 'Promise input should not surface as a fake document')
})

test('buildProfileSectionPrompt: every supported section key produces a non-empty prompt', () => {
  // Mirrors the 14 sections that the user reported 500s for.
  for (const sectionKey of supportedSectionKeys) {
    const out = buildProfileSectionPrompt(sectionKey, {
      profile: baseProfile,
      sections: baseSections,
      documents: [],
    })
    assert.ok(out, `expected prompt payload for section "${sectionKey}"`)
    assert.ok(typeof out.prompt === 'string' && out.prompt.length > 0, `prompt for "${sectionKey}" should be non-empty`)
  }
})

test('buildProfileSectionPrompt: malformed sections argument is tolerated', () => {
  // A future regression that passes `null` or a non-object for sections must not
  // 500 the endpoint. The builder should fall back to {} and keep going.
  const out = buildProfileSectionPrompt('basic_information', {
    profile: baseProfile,
    sections: null,
    documents: [],
  })
  assert.ok(out && typeof out.prompt === 'string')
})
