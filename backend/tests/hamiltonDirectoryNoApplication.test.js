import { describe, it, expect } from 'vitest'
import { resolveUnknownMethod } from '../services/hamilton/hamiltonHardStopResolver.js'

// A POINTER / DIRECTORY / REFERENCE row that URL-rescue cannot turn into a real
// application page is a RESEARCH LEAD, not a task demanding a human "final
// review and submit" (the "Music & Performing Arts Scholarship Finder — the
// submit is yours" class; owner 2026-08-23: "these should be autonomous").
// resolveUnknownMethod must degrade it to no_application, not the manual
// funder-contact packet that parks it in waiting_for_review.

const rescueMiss = { _urlRescueDeps: { searchWebImpl: async () => [], checkUrlImpl: async () => ({ status: 'ok' }) } }

describe('resolveUnknownMethod — pointer/directory rows become research leads, not submit hand-offs', () => {
  it('a DIRECTORY-kind row with no findable application page → no_application (not funder_contact_packet)', async () => {
    const ctx = { opportunity: { title: 'Music & Performing Arts Scholarship Finder', opportunity_kind: 'directory' }, portalUrl: 'https://example.org/finder', ...rescueMiss }
    const d = await resolveUnknownMethod(null, ctx, { url: 'https://example.org/finder' })
    expect(d.outcome).toBe('degraded')
    expect(d.fallback).toBe('no_application')
    expect(d.detail).toMatch(/nothing here for you to review or submit/i)
  })

  it('a row whose OWN url is a non-application surface (wikipedia) → no_application', async () => {
    const ctx = { opportunity: { title: 'NeighborWorks America', opportunity_kind: 'direct' }, portalUrl: 'https://en.wikipedia.org/wiki/NeighborWorks_America', ...rescueMiss }
    const d = await resolveUnknownMethod(null, ctx, { url: 'https://en.wikipedia.org/wiki/NeighborWorks_America' })
    expect(d.outcome).toBe('degraded')
    expect(d.fallback).toBe('no_application')
  })

  it('a REAL award (direct kind, ordinary url) with no findable page STILL gets the funder-contact packet (unchanged)', async () => {
    const ctx = { opportunity: { title: 'Elks National Foundation Most Valuable Student', sponsor: 'Elks National Foundation', opportunity_kind: 'direct' }, portalUrl: 'https://www.elks.org/scholars/scholarships/mvs.cfm', ...rescueMiss }
    const d = await resolveUnknownMethod(null, ctx, { url: 'https://www.elks.org/scholars/scholarships/mvs.cfm' })
    expect(d.outcome).toBe('degraded')
    expect(d.fallback).toBe('manual')
    expect(d.strategy).toBe('funder_contact_packet')
  })

  it('a rescued real application page still wins (no regression to the rescue path)', async () => {
    const ctx = {
      opportunity: { title: 'Ruta Sechaba Foundation High School Scholarship', sponsor: 'Ruta Sechaba Foundation', opportunity_kind: 'direct' },
      portalUrl: null,
      _urlRescueDeps: {
        searchWebImpl: async () => [{ url: 'https://rutasechaba.org/apply', title: 'Ruta Sechaba Foundation High School Scholarship apply', snippet: 'Apply for the Ruta Sechaba Foundation high school scholarship.' }],
        checkUrlImpl: async (u) => ({ status: 'ok', finalUrl: u }),
      },
    }
    const d = await resolveUnknownMethod(null, ctx, {})
    expect(d.outcome).toBe('resolved')
    expect(d.strategy).toBe('application_url_rescued')
  })
})
