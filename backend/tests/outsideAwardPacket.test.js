/**
 * Mail/fax fallback packet — when a portal has no online way to report awards.
 *
 * OWNER RULE (2026-08-01): "Make sure Hamilton knows this and will create a
 * package with instructions that can be mailed or faxed, listed in the
 * documents section of the profile… make sure the profile owner and admin has
 * access to the documents section. If this does happen, make sure the profile
 * owner is alerted."
 *
 * The reporter already refuses to fake a submission. But an honest "I could not
 * do it" with no artifact just hands the work back to the family with extra
 * steps — many schools accept outside-award reports only by mail or fax, so the
 * correct completion of that path is a finished, signable document plus an
 * alert that it exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const { buildOutsideAwardReport } = await import('../services/hamilton/portalSync/outsideAwardPacket.js')

const PROFILE = { id: 'p1', display_name: 'Anastasia White', user_id: 'u1' }
const SOURCES = [
  { name: 'Rotary Club Scholarship', amount: 2000, sponsor: 'Rotary International' },
  { name: 'Elks Lodge Grant', amount: 1500, sponsor: null },
  { name: 'Named Award With No Amount', amount: null, sponsor: null },
]

describe('buildOutsideAwardReport', () => {
  it('lists every accepted award with amounts, and totals only what is known', () => {
    const r = buildOutsideAwardReport({ profile: PROFILE, portalHost: 'mtsu.edu', sources: SOURCES })
    const body = r.sections.map((s) => s.body).join('\n')

    expect(r.title).toMatch(/mtsu\.edu/)
    expect(body).toMatch(/Rotary Club Scholarship/)
    expect(body).toMatch(/\$2,000/)
    expect(body).toMatch(/Rotary International/)
    // An award with no stated amount is listed HONESTLY, not dropped and not
    // given an invented figure.
    expect(body).toMatch(/Named Award With No Amount/)
    expect(body).toMatch(/amount not stated/i)
    // The total is only the money we actually know about.
    expect(body).toMatch(/\$3,500/)
  })

  it('includes a signature block and the student name (a financial-aid office needs a signed statement)', () => {
    const r = buildOutsideAwardReport({ profile: PROFILE, portalHost: 'mtsu.edu', sources: SOURCES })
    const body = r.sections.map((s) => `${s.heading}\n${s.body}`).join('\n')
    expect(body).toMatch(/Signature:/)
    expect(body).toMatch(/Anastasia White/)
    expect(body).toMatch(/Student ID/)
  })

  it('NEVER invents a mailing address — it tells the family to confirm it', () => {
    const r = buildOutsideAwardReport({ profile: PROFILE, portalHost: 'mtsu.edu', sources: SOURCES })
    // Sending a family's private award data to a guessed address would be worse
    // than not producing the packet at all.
    expect(r.mailingInstructions).toMatch(/Confirm the current mailing address/i)
    expect(r.mailingInstructions).toMatch(/will not guess an address/i)
  })

  it('uses a real address / fax / email when the portal contact IS known', () => {
    const r = buildOutsideAwardReport({
      profile: PROFILE,
      portalHost: 'mtsu.edu',
      sources: SOURCES,
      contact: { address: '1301 E Main St, Murfreesboro TN 37132', fax: '615-898-5167', email: 'financialaid@mtsu.edu' },
    })
    expect(r.mailingInstructions).toMatch(/1301 E Main St/)
    expect(r.mailingInstructions).toMatch(/615-898-5167/)
    expect(r.mailingInstructions).toMatch(/financialaid@mtsu\.edu/)
    expect(r.mailingInstructions).not.toMatch(/will not guess an address/i)
  })

  it('tells the family WHY this matters (an unreported award has real consequences)', () => {
    const r = buildOutsideAwardReport({ profile: PROFILE, portalHost: 'mtsu.edu', sources: SOURCES })
    expect(r.mailingInstructions).toMatch(/KEEP A COPY/i)
    expect(r.mailingInstructions).toMatch(/revised aid package|repay/i)
  })
})

describe('generateOutsideAwardPacket — files it in Documents', () => {
  const insertDocumentRecord = vi.fn(async () => 'doc-1')

  beforeEach(() => { vi.resetModules(); insertDocumentRecord.mockClear() })

  it('saves the packet against the PROFILE (which is what gives owner + admin access)', async () => {
    vi.doMock('../services/hamilton/hamiltonApplicationPacketGenerator.js', () => ({
      buildDocxBuffer: vi.fn(async () => Buffer.from('docx')),
      _internal: {
        buildHtml: () => '<html>report</html>',
        tryBuildPdfFromHtml: async () => null,
        insertDocumentRecord,
        getPacketStorageDir: () => os.tmpdir(),
      },
    }))
    const { generateOutsideAwardPacket } = await import('../services/hamilton/portalSync/outsideAwardPacket.js')

    const out = await generateOutsideAwardPacket({ prepare: () => ({ get: async () => null, run: async () => {} }) }, {
      profile: PROFILE, portalHost: 'mtsu.edu', sources: SOURCES,
    })

    expect(out).toBeTruthy()
    expect(out.count).toBe(3)
    const [, doc] = insertDocumentRecord.mock.calls[0]
    // Documents are profile-scoped, and the documents route grants access to
    // the profile's owner and to admins — so filing it under the profile IS the
    // access control. A packet saved with no profile_id would be invisible.
    expect(doc.profileId).toBe('p1')
    expect(doc.type).toBe('hamilton_outside_award_report')
    expect(doc.notes).toMatch(/no online way to submit/i)
  })

  it('produces nothing when there is nothing to report (no empty packets in Documents)', async () => {
    vi.doMock('../services/hamilton/hamiltonApplicationPacketGenerator.js', () => ({
      buildDocxBuffer: vi.fn(async () => Buffer.from('docx')),
      _internal: {
        buildHtml: () => '<html/>', tryBuildPdfFromHtml: async () => null,
        insertDocumentRecord, getPacketStorageDir: () => os.tmpdir(),
      },
    }))
    const { generateOutsideAwardPacket } = await import('../services/hamilton/portalSync/outsideAwardPacket.js')

    expect(await generateOutsideAwardPacket({}, { profile: PROFILE, portalHost: 'x.edu', sources: [] })).toBe(null)
    expect(insertDocumentRecord).not.toHaveBeenCalled()
  })
})

describe('the sync ALERTS the owner when a packet is created', () => {
  it('notifies the profile owner + admins, naming the document and the count', async () => {
    vi.resetModules()
    const emit = vi.fn(async () => ({ ok: true }))
    vi.doMock('../services/hamilton/hamiltonNotifications.js', () => ({
      emitHamiltonNotificationToProfileAndAdmins: emit,
    }))
    vi.doMock('../services/hamilton/portalSync/outsideAwardPacket.js', () => ({
      generateOutsideAwardPacket: vi.fn(async () => ({
        documentIds: ['doc-1', 'doc-2'], title: 'Outside award report — mtsu.edu', count: 2,
      })),
    }))
    const { _internal } = await import('../services/hamilton/portalSync/index.js')

    const packet = await _internal.buildOutsideAwardFallbackPacket({}, {
      profile: PROFILE, profileId: 'p1', host: 'mtsu.edu',
      fundingSources: SOURCES.slice(0, 2), actorUserId: 'u1',
    })

    expect(packet.count).toBe(2)
    expect(emit).toHaveBeenCalledTimes(1)
    const note = emit.mock.calls[0][1]
    // A document that silently appears in a list is barely better than none —
    // the family has to know to look.
    expect(note.type).toBe('hamilton_outside_award_packet_ready')
    expect(note.title).toMatch(/mail or fax/i)
    expect(note.message).toMatch(/Documents/)
    expect(note.message).toMatch(/2 awards/)
    expect(note.message).toMatch(/usually required/i)
    expect(note.data.document_ids).toEqual(['doc-1', 'doc-2'])
    expect(note.profileId).toBe('p1')
    // ADMINS ARE NOT FANNED OUT TO. The helper would otherwise emit a row to
    // every admin; with 39 profiles in prod that is a wall an admin learns to
    // scroll past, burying the one profile that matters. An admin working
    // inside this profile sees the packet in its Documents instead.
    expect(note.adminUserIds).toEqual([])
  })

  it('a notification failure never breaks the sync (the packet still exists)', async () => {
    vi.resetModules()
    vi.doMock('../services/hamilton/hamiltonNotifications.js', () => ({
      emitHamiltonNotificationToProfileAndAdmins: vi.fn(async () => { throw new Error('mail down') }),
    }))
    vi.doMock('../services/hamilton/portalSync/outsideAwardPacket.js', () => ({
      generateOutsideAwardPacket: vi.fn(async () => ({ documentIds: ['doc-1'], title: 'T', count: 1 })),
    }))
    const { _internal } = await import('../services/hamilton/portalSync/index.js')

    const packet = await _internal.buildOutsideAwardFallbackPacket({}, {
      profile: PROFILE, profileId: 'p1', host: 'x.edu', fundingSources: SOURCES, actorUserId: null,
    })
    expect(packet).toBeTruthy()
    expect(packet.count).toBe(1)
  })
})

describe('needsMailFaxPacket — the DECISION (previously untestable inline)', () => {
  it('fires when the portal offered no way to submit and there WAS something to report', async () => {
    vi.resetModules()
    const { needsMailFaxPacket } = await import('../services/hamilton/portalSync/index.js')
    const noForm = { submitted: false, skipped: [{ reason: 'no outside-scholarship reporting form found on this portal' }] }
    const noSubmitControl = { submitted: false, skipped: [{ reason: 'submission was authorized but no submit control was found' }] }
    expect(needsMailFaxPacket(noForm, SOURCES)).toBe(true)
    expect(needsMailFaxPacket(noSubmitControl, SOURCES)).toBe(true)
  })

  it('does NOT fire after a successful submit — no envelope for work already sent', async () => {
    vi.resetModules()
    const { needsMailFaxPacket } = await import('../services/hamilton/portalSync/index.js')
    expect(needsMailFaxPacket({ submitted: true, skipped: [] }, SOURCES)).toBe(false)
    // Even if a stray skip line is present, a real send wins.
    expect(needsMailFaxPacket({ submitted: true, skipped: [{ reason: 'no submit control' }] }, SOURCES)).toBe(false)
  })

  it('does NOT fire with nothing to report (no empty packets, no pointless alerts)', async () => {
    vi.resetModules()
    const { needsMailFaxPacket } = await import('../services/hamilton/portalSync/index.js')
    const noForm = { submitted: false, skipped: [{ reason: 'no outside-scholarship reporting form found' }] }
    expect(needsMailFaxPacket(noForm, [])).toBe(false)
    expect(needsMailFaxPacket(noForm, undefined)).toBe(false)
  })

  it('does NOT fire for an unrelated failure — an unreachable portal is a retry, not an envelope', async () => {
    vi.resetModules()
    const { needsMailFaxPacket } = await import('../services/hamilton/portalSync/index.js')
    expect(needsMailFaxPacket({ submitted: false, skipped: [{ reason: 'Could not reach the portal: net::ERR_TIMED_OUT' }] }, SOURCES)).toBe(false)
    expect(needsMailFaxPacket({ submitted: false, skipped: [] }, SOURCES)).toBe(false)
  })
})
