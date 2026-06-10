/**
 * The Federal Register connector's whole value depends on its funding-signal
 * filter: a raw NOTICE search is ~90% non-funding noise. These cases use real
 * titles/abstracts seen from the live API to pin precision — real NOFOs in,
 * information collections / SEC filings / meetings out.
 */
import { describe, it, expect } from 'vitest'
import { isFundingNotice } from '../src/integrations/federalRegister.js'

describe('isFundingNotice', () => {
  it('keeps real funding notices', () => {
    expect(isFundingNotice(
      'Notice Announcing Fund for the Improvement of Postsecondary Education',
      'This notice announces the availability of funds and invites applications for new awards.',
    )).toBe(true)
    expect(isFundingNotice(
      'Cooperative Agreement to Support Rural Health',
      'Estimated total program funding is $5M; application deadline is listed below.',
    )).toBe(true)
    expect(isFundingNotice(
      'Notice of Funding Opportunity for Stronger Connections Grant Program',
      '',
    )).toBe(true)
    expect(isFundingNotice(
      'Request for Applications: Community Food Projects',
      'The agency invites applications from eligible nonprofit organizations.',
    )).toBe(true)
  })

  it('drops non-funding notices even when funding words appear in the body', () => {
    // Real noise from the live feed:
    expect(isFundingNotice(
      'Agency Information Collection Activities; Comment Request; Stronger Connections Grant Program',
      'The Department is requesting comments on a proposed information collection.',
    )).toBe(false)
    expect(isFundingNotice(
      'Self-Regulatory Organizations; MEMX LLC; Notice of Filing',
      'Notice of filing and immediate effectiveness of a proposed rule change.',
    )).toBe(false)
    expect(isFundingNotice(
      'Sunshine Act Meeting',
      'Notice of a public meeting of the advisory committee.',
    )).toBe(false)
    expect(isFundingNotice(
      'Request for Comment on Chronic Disease of Addiction',
      'HHS requests comment from the public.',
    )).toBe(false)
  })

  it('is safe on empty / missing input', () => {
    expect(isFundingNotice('', '')).toBe(false)
    expect(isFundingNotice(undefined, undefined)).toBe(false)
    expect(isFundingNotice(null, null)).toBe(false)
  })
})
