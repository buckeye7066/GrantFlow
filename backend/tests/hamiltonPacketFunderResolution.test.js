/**
 * REGRESSION — Hamilton packet/proposal funder resolution (#725 drift class).
 *
 * Production loads `opportunity` via `SELECT * FROM funding_opportunities`
 * (column: `sponsor`) and `grant` via `SELECT * FROM grants` (column:
 * `funder`). The generators previously read only phantom aliases
 * (`funder_name`/`organization`/`source_name`/`source_label`), so every
 * packet rendered the literal fallback string "Funder". These tests pin the
 * chain to the REAL row shapes.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPacketContent,
  buildMailingInstructions,
} from '../services/hamilton/hamiltonApplicationPacketGenerator.js'
import { buildFunderRequirements } from '../services/hamilton/hamiltonFullProposalGenerator.js'

const profile = { display_name: 'Test Applicant' }

describe('hamilton packet funder resolution', () => {
  it('buildPacketContent reads sponsor off a funding_opportunities-shaped row', () => {
    const packet = buildPacketContent({
      opportunity: { title: 'STEM Grant', sponsor: 'Volunteer Foundation' },
      grant: null,
      profile,
      automationType: 'application_packet',
    })
    expect(packet.funder).toBe('Volunteer Foundation')
  })

  it('buildPacketContent reads funder off a grants-shaped row', () => {
    const packet = buildPacketContent({
      opportunity: null,
      grant: { title: 'STEM Grant', funder: 'Acme Charitable Trust' },
      profile,
      automationType: 'application_packet',
    })
    expect(packet.funder).toBe('Acme Charitable Trust')
  })

  it('buildMailingInstructions carries the real funder into the mailing subject', () => {
    const mailing = buildMailingInstructions({
      opportunity: { title: 'STEM Grant', sponsor: 'Volunteer Foundation' },
      grant: null,
      automationType: 'application_packet',
    })
    expect(mailing.funder).toBe('Volunteer Foundation')
    expect(mailing.suggested_subject_or_envelope).toContain('Volunteer Foundation')
  })

  it('buildFunderRequirements resolves sponsor (opportunity) and funder (grant)', () => {
    expect(buildFunderRequirements({ title: 'T', sponsor: 'Sponsor Org' }, null).funder).toBe('Sponsor Org')
    expect(buildFunderRequirements(null, { title: 'T', funder: 'Funder Org' }).funder).toBe('Funder Org')
  })

  it('falls back to the neutral label only when the row truly has no name', () => {
    const packet = buildPacketContent({
      opportunity: { title: 'Anonymous Grant' },
      grant: null,
      profile,
      automationType: 'application_packet',
    })
    expect(packet.funder).toBe('Funder')
  })
})

it('mailing instructions use the selected application target without rewriting the source', () => {
  const selected = 'https://www.tn.gov/collegepays/apply'
  const stale = 'https://alpha.grantable.co/login'
  const result = buildMailingInstructions({
    opportunity: { title: 'Student Scholarship', sponsor: 'Student Foundation',
      apply_url: selected, application_url: stale, source_url: 'https://www.tn.gov/collegepays' },
    grant: null, automationType: 'mail',
  })
  expect(result.portal_url).toBe(selected)
  expect(result.funder_url).toBe('https://www.tn.gov/collegepays')
  expect(result.instructions.join(' ')).toContain(selected)
  expect(result.instructions.join(' ')).not.toContain(stale)
})
