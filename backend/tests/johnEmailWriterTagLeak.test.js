/**
 * John's template composer must never print a MACHINE IDENTIFIER at a human.
 *
 * PROD DEFECT (live draft, 2026-07-15): a real outreach draft addressed to the
 * "Johnson City Area Arts Council Inc" contained the sentence
 *
 *   "Between research_arts, Johnson City Area Arts Council Inc is carrying real
 *    weight for the people you serve..."
 *
 * `research_arts` is a canonical need-category ID (label: "Research & Arts", see
 * backend/constants/needCategories.js). Yana's focus/program tags are usually
 * free text, but when they arrive as category IDs `deriveHookPhrase` printed
 * them verbatim into the body and the subject. A raw enum in outreach prose
 * tells the recipient nobody looked at the email before it was queued.
 *
 * The contract: a known id resolves to its canonical LABEL; an unknown
 * machine-looking token is DROPPED (never printed raw, and never de-slugged into
 * a prettified guess the registry never agreed to — that would be inventing a
 * value). Dropping every tag simply leaves hookPhrase null, which the composer
 * already handles with an honest generic line.
 */
import { describe, it, expect } from 'vitest'
import { composeWithTemplate } from '../services/john/johnEmailWriter.js'

/** A lead shaped like the real Johnson City Area Arts Council one. */
function leadWithFocusAreas(areas) {
  return {
    lead_id: 'lead-tag-leak',
    organization_name: 'Johnson City Area Arts Council Inc',
    organization_type: 'nonprofit',
    contact_points: [{ type: 'email', value: 'info@jcarts.example.org' }],
    public_evidence: [
      { type: 'mission', value: 'Nonprofit active in Arts, Culture & Humanities.' },
      { type: 'focus_areas', value: areas },
    ],
    source_urls: ['https://jcarts.example.org'],
  }
}

const composed = (areas) => composeWithTemplate(leadWithFocusAreas(areas), {
  config: { aiComposer: false, sendingMailbox: 'Annie@axiombiolabs.org' },
})

describe('John template composer — machine tags never reach the reader', () => {
  it('never prints the raw category id that shipped in the live draft', () => {
    const { body_text: body, subject } = composed(['research_arts'])
    expect(`${subject} ${body}`).not.toContain('research_arts')
  })

  it('renders a known category id as its canonical label instead', () => {
    const { body_text: body } = composed(['research_arts'])
    // 'Research & Arts' from needCategories, lowercased by the list builder.
    expect(body.toLowerCase()).toContain('research & arts')
  })

  it('drops an UNKNOWN machine id rather than printing or guessing at it', () => {
    const { body_text: body, subject } = composed(['some_unmapped_internal_tag'])
    const all = `${subject} ${body}`
    expect(all).not.toContain('some_unmapped_internal_tag')
    // ...and it must not be de-slugged into an invented label either.
    expect(all).not.toContain('some unmapped internal tag')
  })

  it('still prints ordinary free-text tags untouched', () => {
    const { body_text: body } = composed(['after-school programs'])
    expect(body).toContain('after-school programs')
  })

  it('mixed tags: keeps the real one, drops the machine one', () => {
    const { body_text: body } = composed(['some_unmapped_internal_tag', 'youth mentoring'])
    expect(body).toContain('youth mentoring')
    expect(body).not.toContain('some_unmapped_internal_tag')
  })
})
