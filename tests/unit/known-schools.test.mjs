/**
 * Known schools registry — unit tests.
 *
 * Origin bug: profile "Anastasia" listed Middle Tennessee State University
 * (and 18 other colleges) in `university_applications.applications[]` as
 * `{ name, status }` only, with no `portals`. The crawler's school-card
 * generator therefore handed the user a Google search URL when she asked
 * for "off-campus housing grants or scholarships for MTSU".
 *
 * These tests lock in the fix:
 *   1. `getKnownSchool(name)` resolves common name variants of the same
 *      institution (case + punctuation insensitive, alias aware).
 *   2. `enrichSchool()` fills in real institutional portals without
 *      overwriting any user-supplied portal data.
 *   3. The crawler's `generateSchoolCards` emits a distinct, non-Google
 *      "Off-Campus Housing & Rent Assistance" card pointing at the real
 *      institutional URL when one is known.
 *
 * Mission rule cited:
 *   - Real funding only — no Google-search placeholder URLs when we know
 *     the actual institutional resource.
 *   - Avoid zero-result UX — every target school must produce at least one
 *     real, actionable off-campus housing card.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_SCHOOLS,
  getKnownSchool,
  enrichSchool,
} from '../../backend/services/shared/data/knownSchools.js'
import { generateSchoolCards } from '../../backend/services/crawlers/crawlerManager.js'

describe('knownSchools registry — getKnownSchool', () => {
  it('matches MTSU under multiple common names', () => {
    const variants = [
      'MTSU',
      'mtsu',
      'Middle Tennessee State University',
      'middle tennessee state university',
      '  Middle Tennessee  State  University  ',
    ]
    for (const v of variants) {
      const school = getKnownSchool(v)
      assert.ok(school, `expected MTSU match for variant "${v}"`)
      assert.equal(school.name, 'Middle Tennessee State University')
      assert.match(school.portals.offCampusHousing, /^https:\/\/offcampushousing\.mtsu\.edu/)
      assert.match(school.portals.financialAid, /^https:\/\/(www\.)?mtsu\.edu\//)
    }
  })

  it('matches all of Anastasia\'s 19 target schools', () => {
    const targets = [
      'Middle Tennessee State University',
      'University of Central Florida',
      'University of New Haven',
      'Penn State University',
      'Trevecca Nazarene University',
      'Austin Peay State University',
      'Carson-Newman',
      'Centre College',
      'Christian Brothers University',
      'Oberlin College',
      'Seton Hall University',
      'Ohio State University',
      'University of Alabama',
      'University of Tennessee Chattanooga',
      'University of Tennessee Knoxville',
      'University of Michigan',
      'Florida International University',
      'Harvard University',
      'Lee University',
    ]
    const missing = []
    for (const t of targets) {
      const school = getKnownSchool(t)
      if (!school) missing.push(t)
    }
    assert.equal(missing.length, 0, `Missing known-school entries: ${missing.join(', ')}`)
  })

  it('every registry entry has a real institutional off-campus URL (no google.com placeholders)', () => {
    for (const school of KNOWN_SCHOOLS) {
      assert.ok(school.portals?.offCampusHousing, `${school.name} missing offCampusHousing`)
      assert.ok(
        !/google\.com\/search/.test(school.portals.offCampusHousing),
        `${school.name} offCampusHousing must not be a Google search URL`,
      )
      assert.match(
        school.portals.offCampusHousing,
        /^https:\/\//,
        `${school.name} offCampusHousing must be https`,
      )
    }
  })

  it('returns null for unknown schools so caller can fall back', () => {
    assert.equal(getKnownSchool('Made Up College of Nowhere'), null)
    assert.equal(getKnownSchool(''), null)
    assert.equal(getKnownSchool(null), null)
  })
})

describe('knownSchools — enrichSchool', () => {
  it('fills in real portals for an MTSU stub from a profile', () => {
    const stub = { name: 'Middle Tennessee State University', status: 'planning' }
    const enriched = enrichSchool(stub)
    assert.equal(enriched.knownSchoolMatched, true)
    assert.equal(enriched.state, 'TN')
    assert.match(enriched.portals.financialAid, /mtsu\.edu/)
    assert.match(enriched.portals.housing, /mtsu\.edu/)
    assert.match(enriched.portals.offCampusHousing, /^https:\/\/offcampushousing\.mtsu\.edu/)
    assert.match(enriched.portals.scholarships, /mtsu\.edu/)
    assert.equal(enriched.status, 'planning', 'must preserve user-supplied fields')
  })

  it('does NOT overwrite user-supplied portals', () => {
    const stub = {
      name: 'Middle Tennessee State University',
      portals: { financialAid: 'https://custom.example.com/aid' },
    }
    const enriched = enrichSchool(stub)
    assert.equal(enriched.portals.financialAid, 'https://custom.example.com/aid')
    assert.match(enriched.portals.housing, /mtsu\.edu/, 'still fills in missing housing portal')
  })

  it('returns the original school object unchanged when not in the registry', () => {
    const stub = { name: 'Made Up College of Nowhere' }
    const enriched = enrichSchool(stub)
    assert.equal(enriched, stub)
  })
})

describe('crawlerManager.generateSchoolCards — Anastasia / MTSU end-to-end', () => {
  // Mirrors the Anastasia profile (see backend/config/profile-anastasia.json)
  // — TN, female, high-school senior, applying to MTSU + 18 other colleges.
  const anastasiaAnalysis = {
    applicantType: 'student',
    demographics: new Set(['female']),
    interests: new Set(['forensic science', 'criminal justice', 'stem']),
    sports: new Set(),
    schools: [
      { name: 'Middle Tennessee State University', status: 'planning' },
      { name: 'University of Central Florida', status: 'planning' },
      { name: 'University of Alabama', status: 'planning' },
      { name: 'Made Up College of Nowhere', status: 'planning' },
    ],
  }

  const cards = generateSchoolCards(anastasiaAnalysis)

  it('emits at least 4 cards per known school (finaid, housing, off-campus, scholarships)', () => {
    const mtsuCards = cards.filter((c) => c.schoolName === 'Middle Tennessee State University')
    assert.ok(
      mtsuCards.length >= 4,
      `MTSU should produce ≥ 4 school cards, got ${mtsuCards.length}: ${mtsuCards.map((c) => c.id).join(', ')}`,
    )
  })

  it('MTSU off-campus housing card points at the real mtsu.edu URL, not Google', () => {
    const offCampus = cards.find(
      (c) =>
        c.schoolName === 'Middle Tennessee State University'
        && c.id.startsWith('school-offcampus-'),
    )
    assert.ok(offCampus, 'Off-campus housing card missing for MTSU')
    assert.match(
      offCampus.url,
      /^https:\/\/offcampushousing\.mtsu\.edu/,
      `Expected mtsu.edu off-campus URL, got: ${offCampus.url}`,
    )
    assert.ok(
      !/google\.com\/search/.test(offCampus.url),
      'MTSU off-campus card must not be a Google search URL',
    )
    assert.match(offCampus.name, /Off-Campus Housing & Rent Assistance/)
    assert.ok(
      offCampus.matchReasons.some((r) => /Verified off-campus housing portal/.test(r)),
      'must include verified-portal match reason for known schools',
    )
  })

  it('MTSU financial aid card points at mtsu.edu', () => {
    const finaid = cards.find(
      (c) => c.schoolName === 'Middle Tennessee State University' && c.id.startsWith('school-finaid-'),
    )
    assert.ok(finaid, 'Financial aid card missing for MTSU')
    assert.match(finaid.url, /^https:\/\/(www\.)?mtsu\.edu\//, `Expected mtsu.edu URL, got: ${finaid.url}`)
  })

  it('MTSU scholarships card points at mtsu.edu/financial-aid/scholarships', () => {
    const scholarships = cards.find(
      (c) => c.schoolName === 'Middle Tennessee State University' && c.id.startsWith('school-scholarships-'),
    )
    assert.ok(scholarships)
    assert.match(scholarships.url, /mtsu\.edu\/financial-aid\/scholarships/)
  })

  it('UCF + Alabama off-campus cards also point at the real institutional URLs', () => {
    const ucf = cards.find(
      (c) => c.schoolName === 'University of Central Florida' && c.id.startsWith('school-offcampus-'),
    )
    const bama = cards.find(
      (c) => c.schoolName === 'University of Alabama' && c.id.startsWith('school-offcampus-'),
    )
    assert.ok(
      ucf && /^https:\/\/ucf\.offcampuspartners\.com/.test(ucf.url),
      `UCF off-campus URL bad: ${ucf?.url}`,
    )
    assert.ok(
      bama && /^https:\/\/dos\.sl\.ua\.edu\/programs\/off-campus-resources/.test(bama.url),
      `UA off-campus URL bad: ${bama?.url}`,
    )
  })

  it('unknown school still gets an off-campus card so the user is not zero-result', () => {
    const unknown = cards.find(
      (c) => c.schoolName === 'Made Up College of Nowhere' && c.id.startsWith('school-offcampus-'),
    )
    assert.ok(unknown, 'unknown school must still produce an off-campus card (mission rule: avoid zero-result UX)')
    // For unknown schools the URL is null (never a search-results fallback) and
    // the matchReasons must explicitly say so, so the UI / Anya can warn the user.
    assert.equal(unknown.url, null, 'unknown school card must carry url=null, not a synthesized link')
    assert.ok(
      unknown.matchReasons.some((r) => /Portal URL not yet added/.test(r)),
      'unknown school must surface "Portal URL not yet added" reason for transparency',
    )
  })

  it('URL hygiene: no school card ever carries a search-engine results URL', () => {
    // The old fallback synthesized "google.com/search?q=<school> financial aid
    // office" links that were persisted as application targets and drove
    // Hamilton into Google's sign-in wall (verified in prod). Cards now carry a
    // real institutional URL or null — never a search link.
    for (const card of cards) {
      if (!card.url) continue
      assert.ok(
        !/(google|bing|duckduckgo|yahoo|ecosia)\.[a-z.]+\/(search|html)|[?&]q=/.test(card.url),
        `card ${card.id} must not carry a search-engine URL: ${card.url}`,
      )
    }
  })
})

