import { describe, it, expect } from 'vitest'
import { assessPacketSubmittability } from '../services/hamilton/hamiltonAutomationOrchestrator.js'

// The completeness gate: a packet is "ready" only when its channel is resolved
// AND the info that channel needs is present. Motivated by a real student
// profile's Cade Foundation packet — handed over as ready-to-mail with no
// funder address
// and an unresolved submission channel.
describe('assessPacketSubmittability — the packet completeness gate', () => {
  it('BLOCKS a mail packet with no funder mailing address (the Cade case)', () => {
    const r = assessPacketSubmittability({ automationType: 'mail', mailingInstructions: { mailing_address: null } })
    expect(r.ok).toBe(false)
    expect(r.missing.key).toBe('funder_mailing_address')
    expect(r.missing.required).toBe(true)
    expect(r.reason).toMatch(/address/i)
  })

  it('ALLOWS a mail packet when the mailing address is present', () => {
    const r = assessPacketSubmittability({ automationType: 'mail', mailingInstructions: { mailing_address: '123 Main St, Cleveland TN' } })
    expect(r.ok).toBe(true)
  })

  it('treats a blank/whitespace address as missing (not a real address)', () => {
    expect(assessPacketSubmittability({ automationType: 'mail', mailingInstructions: { mailing_address: '   ' } }).ok).toBe(false)
  })

  it('BLOCKS an unknown/undetermined submission channel', () => {
    const r = assessPacketSubmittability({ automationType: 'something_unmapped', mailingInstructions: {} })
    expect(r.ok).toBe(false)
    expect(r.missing.key).toBe('submission_channel')
  })

  it('BLOCKS fax without a fax number, email without an email, portal without a URL', () => {
    expect(assessPacketSubmittability({ automationType: 'fax', mailingInstructions: {} }).missing.key).toBe('funder_fax')
    expect(assessPacketSubmittability({ automationType: 'email', mailingInstructions: {} }).missing.key).toBe('funder_submission_email')
    expect(assessPacketSubmittability({ automationType: 'portal', mailingInstructions: {} }).missing.key).toBe('portal_url')
  })

  it('ALLOWS fax/email/portal when their target is present', () => {
    expect(assessPacketSubmittability({ automationType: 'fax', mailingInstructions: { fax: '1-555-000-0000' } }).ok).toBe(true)
    expect(assessPacketSubmittability({ automationType: 'email', mailingInstructions: { email: 'grants@funder.org' } }).ok).toBe(true)
    expect(assessPacketSubmittability({ automationType: 'portal', mailingInstructions: { portal_url: 'https://funder.org/apply' } }).ok).toBe(true)
  })

  it('ALLOWS pdf_docx / no_application / auto_profile (no funder-side target needed)', () => {
    expect(assessPacketSubmittability({ automationType: 'pdf_docx', mailingInstructions: {} }).ok).toBe(true)
    expect(assessPacketSubmittability({ automationType: 'no_application', mailingInstructions: {} }).ok).toBe(true)
    expect(assessPacketSubmittability({ automationType: 'auto_profile', mailingInstructions: {} }).ok).toBe(true)
  })
})
