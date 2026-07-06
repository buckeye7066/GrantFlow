import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDefaultJohnEnv, makeQualifiedLead } from './john-test-helpers.mjs'
import { composeEmailFromLead } from '../../backend/services/john/johnEmailWriter.js'
import { getJohnConfig } from '../../backend/services/john/johnOutreachSafety.js'
import { evaluateDraftSafety } from '../../backend/services/john/johnOutreachSafety.js'
import { SAFETY_STATUS } from '../../backend/services/john/johnTypes.js'

test('composeEmailFromLead produces an email that passes the safety classifier', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const cfg = getJohnConfig()
    const lead = makeQualifiedLead({})
    const r = await composeEmailFromLead(lead, { config: cfg })
    assert.equal(r.ok, true)

    // Subject must reference the org or the topic, never deceptive.
    assert.ok(r.subject.length > 5)
    assert.ok(
      r.subject.includes('Riverbend') || r.subject.includes('SCBA') || /Quick note/.test(r.subject),
      `unexpected subject: ${r.subject}`
    )
    // Never clickbait: no ALL-CAPS words (4+ letters) and no exclamation points.
    assert.doesNotMatch(r.subject, /\b[A-Z]{4,}\b/)
    assert.doesNotMatch(r.subject, /!/)

    // Body must include the opt-out line and the configured physical address.
    assert.match(r.body_text, /no thanks/i)
    assert.ok(r.body_text.includes(cfg.physicalAddress), 'physical address not embedded in body')

    // Signature, never promise funding, never claim prior relationship.
    assert.match(r.body_text, /Dr\. John White/)
    assert.match(r.body_text, /Annie@axiombiolabs\.org/)
    assert.doesNotMatch(r.body_text, /\bguarantee\b/i)
    assert.doesNotMatch(r.body_text, /\bas we discussed\b/i)

    // Self-serve CTA: the email invites them to try GrantFlow via the /start
    // funnel (talk to Anya, get a live scan) rather than John running it for them.
    assert.ok(r.body_text.includes(cfg.prospectLink), 'prospect link not embedded in body')
    assert.match(r.body_text, /Anya/)
    assert.equal(r.personalization.prospect_link, cfg.prospectLink)

    // Recipient is the highest-priority valid email.
    assert.equal(r.recipient_email, 'chief@riverbendvfd.test')

    // Personalization records the salutation, evidence, and config snapshot.
    assert.equal(r.personalization.template, 'default')
    assert.equal(r.personalization.salutation, 'Hello Chief Allen,')
    assert.ok(r.personalization.evidence_topic)
    assert.equal(r.personalization.config_snapshot.from_alias, cfg.fromAlias)

    // The value proposition is shaped by the org's funding lane: a fire
    // department hears about firefighter assistance / equipment funding, not
    // a one-size-fits-all "grants and foundation programs" sentence.
    assert.equal(r.personalization.funding_lane, 'fire_ems')
    assert.match(r.body_text, /firefighter assistance|AFG/)
    // The hook leads with the org's OWN evidence, up top.
    assert.match(r.body_text.split('\n\n')[1], /SCBA gear/)
    // No marketing sludge: banned filler phrases never appear.
    assert.doesNotMatch(r.body_text, /I hope this (email )?finds you well/i)
    assert.doesNotMatch(r.body_text, /to whom it may concern/i)
    // No em/en dashes in the deterministic copy (house style).
    assert.doesNotMatch(r.body_text, /[—–]/)

    // The composed draft satisfies the same safety classifier the agent uses.
    const safety = evaluateDraftSafety({
      lead,
      draft: {
        subject: r.subject,
        body: r.body_text,
        recipient_email: r.recipient_email,
      },
      config: cfg,
    })
    assert.equal(safety.status, SAFETY_STATUS.PASSED, JSON.stringify(safety.reasons))
  } finally {
    restore()
  }
})

test('composeEmailFromLead body contains an organization-specific hook', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      organization_name: 'Hope Food Pantry',
      organization_type: 'food pantry',
      public_evidence: [
        {
          summary: 'opened a saturday distribution for senior households',
          source_url: 'https://hope.test/news/saturdays',
          specificity: 'high',
        },
      ],
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.match(r.body_text, /Hope Food Pantry/)
    assert.match(r.body_text, /saturday distribution|senior households/i)
  } finally {
    restore()
  }
})

test('composeEmailFromLead body_html escapes HTML correctly', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({ organization_name: 'A&B <Test>' })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.ok(r.body_html.startsWith('<!doctype html>'))
    assert.ok(r.body_html.includes('A&amp;B &lt;Test&gt;'))
  } finally {
    restore()
  }
})

test('the template dwells on THE ORG\'S OWN WORK when mission/focus facts exist (2026-07-06 warmth pass)', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const cfg = getJohnConfig()
    const lead = makeQualifiedLead({
      public_evidence: [
        { summary: 'replacing 25-year-old SCBA gear', source_url: 'https://riverbendvfd.test/news', specificity: 'high' },
        { type: 'mission_statement', text: 'Protecting the families of Riverbend through rapid response and fire prevention education.' },
        { type: 'focus_areas', value: ['fire response', 'community safety education'] },
      ],
    })
    const r = await composeEmailFromLead(lead, { config: cfg })
    assert.equal(r.ok, true)
    // The their-work paragraph quotes their mission in THEIR OWN words...
    assert.match(r.body_text, /Protecting the families of Riverbend/)
    // ...and reflects their focus areas back to them.
    assert.match(r.body_text, /fire response and community safety education/i)
    assert.equal(r.personalization.their_work_paragraph_included, true)
    // The their-work content appears BEFORE GrantFlow is ever mentioned.
    const firstGrantFlow = r.body_text.indexOf('GrantFlow builds')
    const missionAt = r.body_text.indexOf('Protecting the families')
    assert.ok(missionAt !== -1 && missionAt < firstGrantFlow, 'their work must come before the pitch')
    // Still passes the safety classifier.
    const safety = evaluateDraftSafety({
      lead,
      draft: { subject: r.subject, body: r.body_text, recipient_email: r.recipient_email },
      config: cfg,
    })
    assert.equal(safety.status, SAFETY_STATUS.PASSED, JSON.stringify(safety.reasons))
  } finally {
    restore()
  }
})

test('no their-work paragraph is faked when the facts are thin', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      public_evidence: [
        { summary: 'replacing 25-year-old SCBA gear', source_url: 'https://riverbendvfd.test/news', specificity: 'high' },
      ],
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.equal(r.ok, true)
    assert.equal(r.personalization.their_work_paragraph_included, false)
  } finally {
    restore()
  }
})

// ── Grant-writer no-conflict + trial/billing paragraph (owner, 2026-07-06) ────
// Every draft must acknowledge the recipient may already have a grant writer
// under contract, and state the risk-free mechanics: 7-day free trial with no
// money changing hands (so looking cannot breach an agreement), no contract
// required, weekly/biweekly/monthly billing.
test('every draft carries the grant-writer no-conflict + trial/billing paragraph', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const cfg = getJohnConfig()
    const lead = makeQualifiedLead({})
    const r = await composeEmailFromLead(lead, { config: cfg })
    assert.equal(r.ok, true)
    assert.match(r.body_text, /grant writer/i, 'acknowledges an existing grant writer')
    assert.match(r.body_text, /7-day free trial/i, 'names the 7-day free trial')
    assert.match(r.body_text, /no money changing hands/i, 'no money changes hands while looking')
    assert.match(r.body_text, /never require a contract/i, 'no contract required')
    assert.match(r.body_text, /weekly, biweekly, or monthly/i, 'billing cycles named')
    // No em/en dashes anywhere (John's hard formatting rule).
    assert.doesNotMatch(r.body_text, /[–—]/)
    // The first test in this file already asserts the full composed body
    // (including this paragraph) passes the outbound safety classifier.
  } finally {
    restore()
  }
})
