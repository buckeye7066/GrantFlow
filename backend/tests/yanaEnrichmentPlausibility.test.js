/**
 * Contact-enrichment homepage plausibility gate.
 *
 * PROD DEFECT this guards against (observed 2026-07-15 in the live DB): the
 * enricher SORTED candidate homepages by homepageNameScore and then took
 * candidates[0] unconditionally — a preference with no floor. When no search
 * result matched the org at all, it still accepted the best of a bad lot and
 * scraped that stranger's contact email. Real damage in prod:
 *   - helpdesk@franklin.edu attached to 10 distinct orgs (U Minnesota, UCSF,
 *     U Chicago, UPenn, U Pittsburgh, …)
 *   - admin@conwaydailysun.com (a newspaper) on 14 distinct orgs
 *   - admin@worldatlas.com on 12, support@mathway.com on 6, info@roblox.com on 3
 *   - 147 of 490 enriched candidates shared an address with a DIFFERENT org
 * Each of those makes John draft outreach to the wrong organization.
 *
 * The bar: getting NO email is recoverable (the lead waits at
 * needs_enrichment); emailing the WRONG org is not. These fixtures are the real
 * prod pairs.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { isPlausibleHomepage, distinctiveNameTokens } from '../services/yana/prospectExclusions.js'
import { makeContactEnricher } from '../services/yana/yanaContactEnrichment.js'
import { enforceLeadContactPlausibility } from '../startup/enforceInvariants.js'
import { ensureYanaLeadSchema, _resetYanaSchemaCache } from '../services/yana/yanaLeadDiscovery.js'

describe('distinctiveNameTokens', () => {
  it('drops category words that identify a TYPE of org, not a specific one', () => {
    // 'university' is exactly the token that made Franklin University look like
    // a match for the University of Minnesota.
    expect(distinctiveNameTokens('UNIVERSITY OF MINNESOTA')).toEqual(['minnesota'])
    expect(distinctiveNameTokens('MASSACHUSETTS GENERAL HOSPITAL')).toEqual(['massachusetts'])
  })

  it('falls back to plain tokens when an org name is ALL category words', () => {
    // "Community Health Center" has nothing distinctive — being pickier here
    // would reject every possible homepage.
    expect(distinctiveNameTokens('Community Health Center').length).toBeGreaterThan(0)
  })
})

describe('isPlausibleHomepage — the real prod failures', () => {
  it('rejects the exact wrong sites prod accepted', () => {
    expect(isPlausibleHomepage({ url: 'https://franklin.edu', title: 'Franklin University' }, 'UNIVERSITY OF MINNESOTA')).toBe(false)
    expect(isPlausibleHomepage({ url: 'https://franklin.edu', title: 'Franklin University' }, 'UNIVERSITY OF CALIFORNIA, SAN FRANCISCO')).toBe(false)
    expect(isPlausibleHomepage({ url: 'https://worldatlas.com', title: 'WorldAtlas' }, 'MASSACHUSETTS GENERAL HOSPITAL')).toBe(false)
    expect(isPlausibleHomepage({ url: 'https://conwaydailysun.com', title: 'Conway Daily Sun' }, 'Riverbend Community Fund')).toBe(false)
    expect(isPlausibleHomepage({ url: 'https://mathway.com', title: 'Mathway' }, 'Knox Education Foundation')).toBe(false)
  })

  it('still accepts genuinely matching sites (hostname)', () => {
    expect(isPlausibleHomepage({ url: 'https://stanford.edu', title: 'Stanford University' }, 'STANFORD UNIVERSITY')).toBe(true)
    expect(isPlausibleHomepage({ url: 'https://knoxed.org', title: 'Knox Ed' }, 'Knox Education Foundation')).toBe(true)
  })

  it('accepts a legitimate ABBREVIATED domain via the result title', () => {
    // Hostname alone ('upenn') contains neither 'pennsylvania'; the title saves it.
    expect(isPlausibleHomepage({ url: 'https://upenn.edu', title: 'University of Pennsylvania' }, 'UNIVERSITY OF PENNSYLVANIA')).toBe(true)
    expect(isPlausibleHomepage({ url: 'https://massgeneral.org', title: 'Mass General Brigham' }, 'MASSACHUSETTS GENERAL HOSPITAL')).toBe(false) // no distinctive token — correctly conservative
  })

  it('a shared category word alone is never enough', () => {
    // Both are "universities" — that must not make them the same institution.
    expect(isPlausibleHomepage({ url: 'https://franklin.edu', title: 'Franklin University' }, 'UNIVERSITY OF CHICAGO')).toBe(false)
  })
})

/**
 * SECOND PROD DEFECT (the live Drafts folder, 2026-07-14/15).
 *
 * The one-distinctive-token bar above shipped, and John still drafted real
 * outreach to ten wrong organizations — 8 of these 10 recipients PASSED that
 * gate. A floor of one word is no floor for the names Yana actually discovers,
 * because the one word they share is a surname ("willie") or a place
 * ("decatur", "johnson", "robertson") that a completely unrelated business is
 * equally entitled to. Identity has to be argued from the WHOLE name, and the
 * hostname has to be anchored to it.
 *
 * Every pair below is a REAL draft that was sitting in the owner's mailbox,
 * addressed by name to the org on the left and mailed to the domain on the
 * right. All ten must be rejected.
 */
describe('isPlausibleHomepage — the live wrong-recipient drafts (2026-07-15)', () => {
  const wrongDrafts = [
    // A geography site's "Ohio" page is not the Ohio Education Foundation.
    ['Ohio Education Foundation', 'worldatlas.com'],
    // A watch festival that merely shares the county's name.
    ['Decatur County Education Foundation Inc', 'decaturwatchfest26.com'],
    // A streaming service. The draft body even NARRATES the bad research:
    // "pointed me mostly toward a streaming service and some astronomy pages".
    ['Star News Education Foundation', 'help.starz.com'],
    // Johnson University — shares only the city's name.
    ['Johnson City Area Arts Council Inc', 'johnson.edu'],
    ['Upper Cumberland Regional Arts Council Inc', 'upperinc.com'],
    ['Smith County Education Foundation Inc', 'redvanworkshop.com'],
    // The musician, not the foundation.
    ['Willie Julie Educational Foundation', 'willienelson.com'],
    // Winton Group, a UK investment firm.
    ['Winton Woods Educational Foundation Inc', 'winton.com'],
    // A funeral home. Exactly the #937 class, still shipping.
    ['Robertson Community Health Foundation Inc', 'robertsoncountyfuneralhome.com'],
  ]

  it.each(wrongDrafts)('refuses to address %s at %s', (org, domain) => {
    expect(isPlausibleHomepage({ url: `https://${domain}`, title: '' }, org)).toBe(false)
  })

  it('a title mentioning the org can NOT rescue an unrelated hostname', () => {
    // worldatlas.com genuinely has a page titled "Ohio" — the title is the
    // SEARCH ENGINE's text about a page, never proof of whose page it is.
    expect(isPlausibleHomepage({ url: 'https://worldatlas.com', title: 'Ohio - WorldAtlas' }, 'Ohio Education Foundation')).toBe(false)
  })

  it('one shared distinctive word is a coincidence, not an identity', () => {
    // The whole bug in one line: 'willie' is in both, and they are unrelated.
    expect(distinctiveNameTokens('Willie Julie Educational Foundation')).toContain('willie')
    expect(isPlausibleHomepage({ url: 'https://willienelson.com', title: '' }, 'Willie Julie Educational Foundation')).toBe(false)
  })
})

describe('makeContactEnricher — refuses a stranger\'s email', () => {
  const env = { YANA_ALLOW_LIVE_WEB: 'true' }

  it('returns no_plausible_homepage instead of scraping an unrelated site', async () => {
    let fetched = null
    const enricher = makeContactEnricher({
      env,
      searchProvider: async () => [{ url: 'https://franklin.edu', title: 'Franklin University' }],
      fetcher: async (u) => { fetched = u; return '<a href="mailto:helpdesk@franklin.edu">help</a>' },
    })
    const res = await enricher.enrich({ organization_name: 'UNIVERSITY OF MINNESOTA', city: 'MINNEAPOLIS', state: 'MN' })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_plausible_homepage')
    expect(res.email).toBeUndefined()
    // It must not even fetch the wrong site.
    expect(fetched).toBeNull()
  })

  it('still enriches when a plausible homepage IS present among the noise', async () => {
    const enricher = makeContactEnricher({
      env,
      searchProvider: async () => [
        { url: 'https://franklin.edu', title: 'Franklin University' },       // decoy
        { url: 'https://umn.edu', title: 'University of Minnesota' },        // real
      ],
      fetcher: async () => '<a href="mailto:research@umn.edu">contact</a>',
    })
    const res = await enricher.enrich({ organization_name: 'UNIVERSITY OF MINNESOTA' })
    expect(res.ok).toBe(true)
    expect(res.website_url).toBe('https://umn.edu')
    expect(res.email).toBe('research@umn.edu')
    expect(res.email_source_url).toBe('https://umn.edu')
  })
})

describe('enforceLeadContactPlausibility — the boot net for rows already poisoned', () => {
  async function seed(rows) {
    _resetYanaSchemaCache()
    const db = new Database(':memory:')
    await ensureYanaLeadSchema(db)
    for (const r of rows) {
      await db.prepare(
        `INSERT INTO yana_lead_candidates
           (id, source, external_id, organization_name, entity_type, contact_email,
            qualification_status, pushed_to_john, enrich_attempts, lead_score, contact_confidence)
         VALUES (?, 'nih_reporter', ?, ?, 'research_institution', ?, ?, ?, 3, 90, 100)`,
      ).run(r.id, r.id, r.org, r.email, r.status || 'qualified', r.pushed ?? 1)
    }
    return db
  }

  it('strips a stranger\'s address and returns the lead to needs_enrichment', async () => {
    const db = await seed([{ id: 'a', org: 'UNIVERSITY OF MINNESOTA', email: 'helpdesk@franklin.edu' }])
    const res = await enforceLeadContactPlausibility(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1)

    const row = await db.prepare('SELECT * FROM yana_lead_candidates WHERE id = ?').get('a')
    expect(row.contact_email).toBeNull()
    expect(row.qualification_status).toBe('needs_enrichment')
    // Un-pushed and retry budget reset, so the now-gated enricher gets a fresh
    // chance to find the RIGHT address instead of the lead being stuck.
    expect(row.pushed_to_john).toBe(0)
    expect(row.enrich_attempts).toBe(0)
    // The org itself is never deleted — it just waits until honestly reachable.
    expect(row.organization_name).toBe('UNIVERSITY OF MINNESOTA')
  })

  it('leaves a genuinely matching address alone', async () => {
    const db = await seed([{ id: 'b', org: 'STANFORD UNIVERSITY', email: 'soe_mediarelations@stanford.edu' }])
    const res = await enforceLeadContactPlausibility(db)
    expect(res.repaired).toBe(0)
    const row = await db.prepare('SELECT * FROM yana_lead_candidates WHERE id = ?').get('b')
    expect(row.contact_email).toBe('soe_mediarelations@stanford.edu')
    expect(row.qualification_status).toBe('qualified')
  })

  it('is idempotent — a second sweep repairs nothing', async () => {
    const db = await seed([{ id: 'c', org: 'MASSACHUSETTS GENERAL HOSPITAL', email: 'admin@worldatlas.com' }])
    expect((await enforceLeadContactPlausibility(db)).repaired).toBe(1)
    expect((await enforceLeadContactPlausibility(db)).repaired).toBe(0)
  })

  it('counts without changing anything when ENFORCE_LEAD_CONTACT_PLAUSIBILITY=0', async () => {
    const db = await seed([{ id: 'd', org: 'UNIVERSITY OF CHICAGO', email: 'helpdesk@franklin.edu' }])
    process.env.ENFORCE_LEAD_CONTACT_PLAUSIBILITY = '0'
    try {
      const res = await enforceLeadContactPlausibility(db)
      expect(res.enforced).toBe(false)
      expect(res.wouldRepair).toBe(1)
      expect(res.repaired).toBe(0)
      const row = await db.prepare('SELECT contact_email FROM yana_lead_candidates WHERE id = ?').get('d')
      expect(row.contact_email).toBe('helpdesk@franklin.edu') // untouched
    } finally {
      delete process.env.ENFORCE_LEAD_CONTACT_PLAUSIBILITY
    }
  })

  it('degrades to a skip (not a failure) on a DB with no Yana tables', async () => {
    const res = await enforceLeadContactPlausibility(new Database(':memory:'))
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe('schema')
  })
})
