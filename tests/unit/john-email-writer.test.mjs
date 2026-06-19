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

    // Body must include the opt-out line and the configured physical address.
    assert.match(r.body_text, /no thanks/i)
    assert.ok(r.body_text.includes(cfg.physicalAddress), 'physical address not embedded in body')

    // Signature, never promise funding, never claim prior relationship.
    assert.match(r.body_text, /Dr\. John White/)
    assert.match(r.body_text, /GrantFlow@axiombiolabs\.org/)
    assert.doesNotMatch(r.body_text, /\bguarantee\b/i)
    assert.doesNotMatch(r.body_text, /\bas we discussed\b/i)

    // Self-serve CTA: the email invites them to try GrantFlow via the /start
    // funnel (talk to Anya, get a live scan) rather than John running it for them.
    assert.ok(r.body_text.includes(cfg.prospectLink), 'prospect link not embedded in body')
    assert.match(r.body_text, /Anya/)
    assert.equal(r.personalization.prospect_link, cfg.prospectLink)

    // Recipient is the highest-priority valid email.
    assert.equal(r.recipient_email, 'chief@riverbendvfd.example.org')

    // Personalization records the salutation, evidence, and config snapshot.
    assert.equal(r.personalization.template, 'default')
    assert.equal(r.personalization.salutation, 'Hi Chief,')
    assert.ok(r.personalization.evidence_topic)
    assert.equal(r.personalization.config_snapshot.from_alias, cfg.fromAlias)

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
          source_url: 'https://hope.example.org/news/saturdays',
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
