import { describe, it, expect } from 'vitest'
import {
  SOURCE_ARCHETYPES,
  KNOWN_SEED_LIMIT_PER_RUN,
  resolveArchetypeType,
  resolveArchetypesForProfile,
  knownSeedSourcesForProfile,
} from '../config/profileSourceArchetypes.js'

// A well-formed http(s) URL with a real host (the "a wrong/dead URL is worse
// than none" bar — at minimum every URL must parse and be absolute).
function isWellFormedUrl(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false
  try {
    const parsed = new URL(u)
    return Boolean(parsed.hostname && parsed.hostname.includes('.'))
  } catch {
    return false
  }
}

function categoriesOf(rows) {
  return new Set(rows.map((r) => r.category))
}
function seedUrls(seeds) {
  return seeds.map((s) => s.url)
}
function hostsOf(seeds) {
  return new Set(seeds.map((s) => new URL(s.url).hostname.replace(/^www\./, '')))
}

describe('SOURCE_ARCHETYPES registry integrity', () => {
  it('every known_source across every archetype has a real, well-formed URL and a name', () => {
    let count = 0
    for (const [type, archetypes] of Object.entries(SOURCE_ARCHETYPES)) {
      expect(Array.isArray(archetypes), `${type} must be an array`).toBe(true)
      for (const a of archetypes) {
        expect(typeof a.category, `${type} category`).toBe('string')
        expect(a.category.length).toBeGreaterThan(0)
        expect(Array.isArray(a.known_sources), `${type}/${a.category} known_sources`).toBe(true)
        expect(Array.isArray(a.query_patterns), `${type}/${a.category} query_patterns`).toBe(true)
        expect(a.query_patterns.length).toBeGreaterThan(0)
        for (const src of a.known_sources) {
          count += 1
          expect(typeof src.name, `${type}/${a.category} source name`).toBe('string')
          expect(src.name.trim().length).toBeGreaterThan(0)
          expect(
            isWellFormedUrl(src.url),
            `${type}/${a.category} URL not well-formed: ${src.url}`,
          ).toBe(true)
        }
      }
    }
    // Guard against an accidentally emptied registry (a no-op registry passes
    // the per-URL checks vacuously).
    expect(count).toBeGreaterThan(40)
  })

  it('query_patterns only use the documented placeholder tokens', () => {
    const allowed = new Set(['geo', 'state', 'need', 'sector', 'year'])
    for (const archetypes of Object.values(SOURCE_ARCHETYPES)) {
      for (const a of archetypes) {
        for (const q of a.query_patterns) {
          for (const m of q.matchAll(/\{([a-z_]+)\}/g)) {
            expect(allowed.has(m[1]), `unknown placeholder {${m[1]}} in "${q}"`).toBe(true)
          }
        }
      }
    }
  })
})

describe('resolveArchetypeType', () => {
  it('resolves a specific org type over a generic individual default', () => {
    const type = resolveArchetypeType(
      { primary_type: 'individual' },
      { organization_details: { organization_type: 'small_business' } },
    )
    expect(type).toBe('business')
  })

  it('returns null for an unresolvable / empty profile (MISSING = NEUTRAL)', () => {
    expect(resolveArchetypeType({}, {})).toBe(null)
    expect(resolveArchetypeType({ primary_type: 'not_a_real_type_xyz' }, {})).toBe(null)
  })

  it('resolves a college_student alias to the canonical id', () => {
    expect(resolveArchetypeType({ primary_type: 'undergraduate' }, {})).toBe('college_student')
  })
})

describe('resolveArchetypesForProfile — type + parent-chain rollup', () => {
  it('a small_business profile resolves to the business archetypes', () => {
    const rows = resolveArchetypesForProfile({ primary_type: 'small_business' }, {})
    const cats = categoriesOf(rows)
    expect(cats.has('federal_small_business')).toBe(true)
    expect(cats.has('corporate_small_business_grants')).toBe(true)
    expect(cats.has('state_and_local_economic_development')).toBe(true)
  })

  it('a women_owned_business ALSO inherits the generic business archetypes AND gets women-business funds', () => {
    const rows = resolveArchetypesForProfile({ primary_type: 'women_owned_business' }, {})
    const cats = categoriesOf(rows)
    // Inherited from the `business` parent:
    expect(cats.has('federal_small_business')).toBe(true)
    expect(cats.has('corporate_small_business_grants')).toBe(true)
    // Its own women-specific archetype:
    expect(cats.has('women_business_grant_funds')).toBe(true)
  })

  it('a college_student inherits the generic student scholarship hubs', () => {
    const rows = resolveArchetypesForProfile({ primary_type: 'college_student' }, {})
    const cats = categoriesOf(rows)
    expect(cats.has('scholarship_hubs')).toBe(true)
    expect(cats.has('federal_student_aid')).toBe(true)
  })

  it('a teacher inherits the classroom-grant archetype through the educator parent', () => {
    const rows = resolveArchetypesForProfile({ primary_type: 'teacher' }, {})
    expect(categoriesOf(rows).has('classroom_and_teacher_grants')).toBe(true)
    const hosts = hostsOf(knownSeedSourcesForProfile({ primary_type: 'teacher' }, {}))
    expect(hosts.has('donorschoose.org')).toBe(true)
  })

  it('an unresolvable profile returns [] (never a wrong archetype)', () => {
    expect(resolveArchetypesForProfile({}, {})).toEqual([])
    expect(resolveArchetypesForProfile({ primary_type: 'zzz' }, {})).toEqual([])
  })

  it('the women/minority refinement only fires for a business, and only on a STRUCTURED flag', () => {
    // A structured women_owned flag on an individual must NOT add the business fund.
    const individual = resolveArchetypesForProfile(
      { primary_type: 'individual' },
      { small_business_details: { women_owned: true } },
    )
    expect(categoriesOf(individual).has('women_business_grant_funds')).toBe(false)

    // The same flag on a business DOES.
    const biz = resolveArchetypesForProfile(
      { primary_type: 'business' },
      { small_business_details: { women_owned: true } },
    )
    expect(categoriesOf(biz).has('women_business_grant_funds')).toBe(true)
  })

  it('a structured agriculture sector adds the farm archetype', () => {
    const rows = resolveArchetypesForProfile(
      { primary_type: 'business' },
      { small_business_details: { industry: 'Agriculture / crop production' } },
    )
    expect(categoriesOf(rows).has('agricultural_producer_grants')).toBe(true)
  })
})

describe('knownSeedSourcesForProfile — the seed contract', () => {
  it('returns {url,title,snippet} seeds, deduped and bounded', () => {
    const seeds = knownSeedSourcesForProfile({ primary_type: 'business' }, {})
    expect(seeds.length).toBeGreaterThan(0)
    expect(seeds.length).toBeLessThanOrEqual(KNOWN_SEED_LIMIT_PER_RUN)
    for (const s of seeds) {
      expect(isWellFormedUrl(s.url)).toBe(true)
      expect(typeof s.title === 'string' || s.title === null).toBe(true)
      expect(typeof s.snippet).toBe('string')
    }
    // De-duped by normalized URL.
    const norm = seeds.map((s) => s.url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''))
    expect(new Set(norm).size).toBe(norm.length)
  })

  it('Olivia (women-owned holistic-wellness LLC) now seeds REAL small-business funders', () => {
    // The motivating profile: a small-business LLC that had ZERO pipeline
    // sources. After wiring she must reach SBA + the corporate small-business
    // funds the models named (Hello Alice, Comcast RISE, FedEx) + women funds.
    const olivia = {
      primary_type: 'small_business',
    }
    const sections = {
      organization_details: { organization_type: 'small_business' },
      small_business_details: { women_owned: true, industry: 'Holistic wellness' },
    }
    const hosts = hostsOf(knownSeedSourcesForProfile(olivia, sections))
    expect(hosts.has('sba.gov')).toBe(true)
    expect(hosts.has('helloalice.com')).toBe(true)
    // A women-owned refinement source is present (Amber Grant / IFundWomen).
    const anyWomenFund = ['ambergrantsforwomen.com', 'ifundwomen.com'].some((h) => hosts.has(h))
    expect(anyWomenFund).toBe(true)
  })

  it('a student seeds the scholarship hubs (Fastweb / Bold.org / Scholarships.com)', () => {
    const hosts = hostsOf(knownSeedSourcesForProfile({ primary_type: 'student' }, {}))
    expect(hosts.has('fastweb.com')).toBe(true)
    const anyHub = ['bold.org', 'scholarships.com', 'goingmerry.com'].some((h) => hosts.has(h))
    expect(anyHub).toBe(true)
  })

  it('an unconfigured / typeless profile seeds nothing (MISSING = NEUTRAL)', () => {
    expect(knownSeedSourcesForProfile({}, {})).toEqual([])
  })

  it('bounds the seed list', () => {
    // A business + women + minority + farm-refined profile has more than the
    // per-run bound of known sources; the returned list must be capped.
    const seeds = knownSeedSourcesForProfile(
      { primary_type: 'business' },
      { small_business_details: { women_owned: true, minority_owned: true, industry: 'farm produce' } },
      { limit: 4 },
    )
    expect(seeds.length).toBe(4)
  })
})
