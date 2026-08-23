/**
 * Yana outreach-email selection — the SUPPLY-side fix for John's empty mailbox.
 *
 * Root cause (measured in prod 2026-08-23): John drafted ~10 outreach emails/day
 * to recipients the plausibility gate then auto-archived — 44 of the last 50
 * drafts (88%) as `implausible_recipient`. The homepage selection was CORRECT
 * (berkeley.edu, upenn.edu, luriechildrens.org, reynoldsburgeducationfoundation.org);
 * the EMAIL scraped off that homepage was the defect. Three classes, one per
 * verbatim prod failure:
 *   - WRONG ORG:   info@indiantypefoundry.com scraped off the (right) homepage
 *                  reynoldsburgeducationfoundation.org — a font vendor embedded
 *                  in the page. Off the org's own registrable domain.
 *   - MALFORMED:   u@penn.php scraped off upenn.edu — `.php` mistaken for a TLD.
 *   - GENERIC-ONLY: webadmin@berkeley.edu / webmaster@luriechildrens.org — right
 *                  domain, but a web-infra mailbox, not an outreach contact.
 *
 * chooseOutreachEmail() refuses all three at the source: a recipient must be on
 * the org's OWN verified-homepage registrable domain, realistically shaped, and
 * a real outreach/person mailbox (a bare webmaster/webadmin is never a first
 * choice). When none qualifies it returns ok:false so the lead stays
 * needs_enrichment (surfaced to the owner as needs-contact) instead of being
 * drafted-then-archived.
 *
 * MUTATION VERIFICATION (each reverts exactly one guard; run reddens only its own):
 *   - drop the same-domain `.filter` in chooseOutreachEmail   → "wrong org" reddens
 *   - drop isRealisticContactEmail's FILE_EXT_TLD/len check     → "malformed" reddens
 *   - make classifyContactLocal never return 'weak'            → "generic-only" reddens
 *   - remove the weak-demotion from the rank()                 → "prefers a real
 *                                                                 outreach mailbox" reddens
 */

import { describe, it, expect } from 'vitest'
import {
  chooseOutreachEmail,
  isRealisticContactEmail,
  classifyContactLocal,
  registrableDomain,
} from '../services/yana/prospectExclusions.js'
import { makeContactEnricher } from '../services/yana/yanaContactEnrichment.js'

describe('isRealisticContactEmail — mailbox shape', () => {
  it('accepts a real same-domain contact', () => {
    expect(isRealisticContactEmail('grants@berkeley.edu')).toBe(true)
    expect(isRealisticContactEmail('jane.smith@luriechildrens.org')).toBe(true)
  })
  it('rejects the malformed u@penn.php class (file-ext TLD + 1-char local)', () => {
    expect(isRealisticContactEmail('u@penn.php')).toBe(false)
    expect(isRealisticContactEmail('x@logo.png')).toBe(false)
    expect(isRealisticContactEmail('a@b..com')).toBe(false)
  })
})

describe('registrableDomain — subdomain robustness', () => {
  it('collapses www/subdomains but keeps multi-part suffixes', () => {
    expect(registrableDomain('https://www.berkeley.edu/')).toBe('berkeley.edu')
    expect(registrableDomain('news.give.berkeley.edu')).toBe('berkeley.edu')
    expect(registrableDomain('info@charity.org.uk')).toBe('charity.org.uk')
  })
})

describe('classifyContactLocal', () => {
  it('marks web-infra mailboxes weak, outreach boxes outreach, named boxes person', () => {
    expect(classifyContactLocal('webmaster@x.org')).toBe('weak')
    expect(classifyContactLocal('webadmin@x.org')).toBe('weak')
    expect(classifyContactLocal('grants@x.org')).toBe('outreach')
    expect(classifyContactLocal('info@x.org')).toBe('outreach')
    expect(classifyContactLocal('jane.smith@x.org')).toBe('person')
  })
})

describe('chooseOutreachEmail — the four prod failures', () => {
  it('WRONG ORG: refuses a vendor address embedded on the right homepage', () => {
    const r = chooseOutreachEmail(['info@indiantypefoundry.com'], {
      orgDomain: 'https://reynoldsburgeducationfoundation.org/about-us',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_org_owned_contact')
  })

  it('MALFORMED: refuses u@penn.php scraped off upenn.edu', () => {
    const r = chooseOutreachEmail(['u@penn.php'], { orgDomain: 'https://www.upenn.edu/' })
    expect(r.ok).toBe(false)
  })

  it('GENERIC-ONLY: refuses a bare web-infra mailbox even on the right domain', () => {
    const berkeley = chooseOutreachEmail(['webadmin@berkeley.edu'], { orgDomain: 'https://www.berkeley.edu/' })
    expect(berkeley.ok).toBe(false)
    expect(berkeley.generic).toBe(true)
    expect(berkeley.reason).toBe('only_generic_web_mailbox')

    const lurie = chooseOutreachEmail(['webmaster@luriechildrens.org'], { orgDomain: 'https://www.luriechildrens.org/' })
    expect(lurie.ok).toBe(false)
    expect(lurie.generic).toBe(true)
  })
})

describe('chooseOutreachEmail — accepts and ranks real contacts', () => {
  it('prefers a real outreach mailbox over a generic web mailbox', () => {
    const r = chooseOutreachEmail(
      ['webmaster@hope.org', 'info@hope.org', 'grants@hope.org'],
      { orgDomain: 'https://www.hope.org/' },
    )
    expect(r.ok).toBe(true)
    expect(r.email).toBe('grants@hope.org') // grants desk beats info@ and webmaster@
  })

  it('accepts a same-domain named-person mailbox', () => {
    const r = chooseOutreachEmail(['jane.doe@hope.org'], { orgDomain: 'hope.org' })
    expect(r.ok).toBe(true)
    expect(r.email).toBe('jane.doe@hope.org')
  })

  it('accepts across subdomains (registrable-domain match)', () => {
    const r = chooseOutreachEmail(['development@hope.org'], { orgDomain: 'https://give.hope.org' })
    expect(r.ok).toBe(true)
  })
})

describe('makeContactEnricher — end to end, homepage correct but email bad', () => {
  const base = { env: { YANA_ALLOW_LIVE_WEB: 'true' } }

  it('leaves email null when only a wrong-org vendor address is on the page', async () => {
    const enricher = makeContactEnricher({
      ...base,
      searchProvider: async () => [
        { url: 'https://reynoldsburgeducationfoundation.org/about-us', title: 'Reynoldsburg Education Foundation', snippet: '' },
      ],
      fetcher: async () =>
        '<html><body>Fonts by <a href="mailto:info@indiantypefoundry.com">Indian Type Foundry</a></body></html>',
    })
    const res = await enricher.enrich({ organization_name: 'Reynoldsburg Education Foundation' })
    // Homepage is right, but no same-domain contact → email null → lead stays
    // needs_enrichment (owner sees it as needs-contact), never a wrong-org draft.
    expect(res.website_url).toBe('https://reynoldsburgeducationfoundation.org/about-us')
    expect(res.email).toBeNull()
    expect(res.email_source_url).toBeNull()
  })

  it('leaves email null when only a generic webmaster address is on the page', async () => {
    const enricher = makeContactEnricher({
      ...base,
      searchProvider: async () => [
        { url: 'https://www.hopechildrens.org/', title: "Hope Children's Foundation", snippet: '' },
      ],
      fetcher: async () => '<html><body><a href="mailto:webmaster@hopechildrens.org">web</a></body></html>',
    })
    const res = await enricher.enrich({ organization_name: "Hope Children's Foundation" })
    // Right domain, but only a web-infra mailbox → not drafted; needs-contact.
    expect(res.email).toBeNull()
  })

  it('attaches a real same-domain outreach mailbox when the org publishes one', async () => {
    const enricher = makeContactEnricher({
      ...base,
      searchProvider: async () => [
        { url: 'https://www.hopefoundation.org/', title: 'Hope Foundation', snippet: '' },
      ],
      fetcher: async () =>
        '<html><body><a href="mailto:grants@hopefoundation.org">Grants</a> <a href="mailto:webmaster@hopefoundation.org">web</a></body></html>',
    })
    const res = await enricher.enrich({ organization_name: 'Hope Foundation' })
    expect(res.email).toBe('grants@hopefoundation.org')
    expect(res.email_source_url).toBe('https://www.hopefoundation.org/')
  })
})
