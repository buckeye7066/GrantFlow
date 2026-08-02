/**
 * A profile's ITEM LIST comes from what the profile SAID — with an address.
 *
 * THE DEFECT (measured 2026-08-02). `services/itemCatalogService.suggestItemsForProfile`
 * scores a NINE-ROW fixture (laptop / desktop / hotspot / wheelchair van /
 * wheelchair / hearing aids / vision glasses / school supplies / work clothing)
 * against coarse need buckets and asks an LLM for the rest. Focus Forward
 * Ministry — a faith-based 501(c)(3) whose declared focus areas literally
 * include "Building supplies" — is a nonprofit, and the fixture holds no
 * building supplies at all.
 *
 * These tests pin the three properties that make the replacement honest:
 * PROVENANCE (every entry names the field it came from), APPLICABILITY (a
 * person-only section never derives a need for an organization), and
 * PRECISION (a declared value that names no purchasable thing is an explicit,
 * convergent gap — never a guess and never silence).
 *
 * The profile fixtures below are the REAL prod sections of
 * `profile-focus-forward-ministries` and `profile-john-white`, read read-only
 * on 2026-08-02.
 */
import { describe, it, expect } from 'vitest'
import {
  ITEM_NEED_RULES,
  SUPPORT_NEED_ITEMS,
  DISABILITY_TYPE_ITEMS,
  HEALTH_FLAG_ITEMS,
  CREDENTIAL_ROLE_ITEMS,
  ITEM_TAG_VOCABULARY,
  MAX_ITEM_NEEDS,
  deriveProfileItemNeeds,
  ruleAppliesToProfile,
} from '../config/profileItemNeeds.js'
import fs from 'node:fs'
import { PROFILE_SCHEMA, isFieldScored, resolveFieldFormat, getUnscoredProseFieldNames } from '../config/profileSchema.js'
import { SECTION_METADATA } from '../../src/config/sectionMetadata.js'

const readSource = () =>
  fs.readFileSync(new URL('../config/profileItemNeeds.js', import.meta.url), 'utf8')

/**
 * The module's CODE, with comments stripped.
 *
 * The source scans below assert what the module READS. Scanning raw source made
 * them fire on the file's own documentation — the header explains that
 * `narrative.primary_goal` is prose and deliberately NOT mined, and a naive
 * scan read that sentence as evidence of mining it. A guard that a correct
 * explanation can trip is a guard that teaches people to delete explanations.
 */
const readCode = () =>
  readSource()
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── Real prod fixtures ──────────────────────────────────────────────────────

const FOCUS_FORWARD = {
  profile: { id: 'profile-focus-forward-ministries', primary_type: 'nonprofit' },
  sections: {
    programs_services: {
      focus_areas: [
        'Indigenous outreach', 'Poverty alleviation', 'Community empowerment',
        'Spiritual support', 'Sustainable support', 'Discipleship', 'Building supplies',
      ],
      interests: ['Faith-based service', 'Rural outreach', 'Minority-serving initiatives', 'Compassionate ministry'],
      keywords: ['Sioux', 'South Dakota', 'Pine Ridge Indian Reservation', 'building supplies', 'discipleship'],
    },
    // Imported artifacts: person-only sections on an ORGANIZATION profile.
    housing: { status: 'stable', broadband_speed: 'low', geographic_designation: ['rural'] },
    health_medical: { disability_type: ['physical'], support_needs_level: 'moderate' },
    organization_details: { is_501c3_public_charity: true, is_faith_based: true },
  },
}

const JOHN_WHITE = {
  profile: { id: 'profile-john-white', primary_type: 'individual' },
  sections: {
    occupation: { healthcare_worker_type: 'RN', ems_worker: false, firefighter: false, farmer: false },
    health_medical: {
      conditions: 'Stage 4 Adenocarcinoma survivor, CIPN, Brain Fog, ',
      disability_type: ['CIPN', 'mobility', 'arthritis', 'unsteady gait'],
      support_needs: [
        'transportation', 'copay assistance', 'lodging', 'caregiver support',
        'educational resources for community wellness initiatives',
        'financial assistance for underserved populations',
        'access to healthcare services',
      ],
      wheelchair_user: false, visual_impairment: false, hearing_impairment: false,
    },
    housing: { status: 'stable', broadband_speed: 'high' },
    programs_services: { focus_areas: ['community health education', 'nutrition assistance'] },
  },
}

describe('profileItemNeeds — the registry', () => {
  it('every rule is consulted by deriveProfileItemNeeds (totality)', () => {
    // A rule that no profile shape can reach is a rule that silently does
    // nothing. Union the fields consulted across a person and an org profile:
    // together they must cover the whole registry.
    const person = deriveProfileItemNeeds({ primary_type: 'individual' }, {})
    const org = deriveProfileItemNeeds({ primary_type: 'nonprofit' }, {})
    const consulted = new Set([
      ...person.consultedFields, ...person.notApplicableFields,
      ...org.consultedFields, ...org.notApplicableFields,
    ])
    for (const rule of ITEM_NEED_RULES) {
      expect(consulted.has(rule.id), `rule ${rule.id} is never consulted`).toBe(true)
    }
    expect(consulted.size).toBe(ITEM_NEED_RULES.length)
  })

  it('every rule names a REAL schema section (no rule reads a section that does not exist)', () => {
    for (const rule of ITEM_NEED_RULES) {
      expect(PROFILE_SCHEMA[rule.section], `rule ${rule.id} names unknown section ${rule.section}`).toBeTruthy()
    }
  })

  it('no rule reads a DEPRECATED field', () => {
    // `basic_information.keywords` is a deprecated legacy intake mirror
    // ("Canonical keywords live in programs_services.keywords") and is absent
    // from PROFILE_SCHEMA entirely. `isFieldScored` already excludes deprecated
    // fields from scoring and mining; deriving items from one would re-open the
    // same drift on a different door. The rule that read it was removed — it
    // only ever produced a duplicate of the canonical `programs_services` entry.
    for (const rule of ITEM_NEED_RULES) {
      for (const key of rule.reads) {
        const meta = PROFILE_SCHEMA[rule.section]?.fields?.[key]
        expect(meta?.deprecated, `rule ${rule.id} reads deprecated ${rule.section}.${key}`).toBeFalsy()
      }
    }
  })

  it('NO RULE READS PROSE — every `reads` key is a real, non-prose schema field', () => {
    // The #1096 bar. Its predecessor detected needs from rendered profile TEXT
    // and minted a `housing` need from the sentence "We do not need housing
    // assistance of any kind": prose cannot be distinguished from its own
    // denial. Structured arrays and `=== true` flags only.
    for (const rule of ITEM_NEED_RULES) {
      expect(Array.isArray(rule.reads) && rule.reads.length > 0, `rule ${rule.id} declares no reads[]`).toBe(true)
      for (const key of rule.reads) {
        const meta = PROFILE_SCHEMA[rule.section]?.fields?.[key]
        expect(meta, `${rule.section}.${key} is not a declared schema field`).toBeTruthy()
        expect(
          resolveFieldFormat(meta),
          `rule ${rule.id} reads PROSE field ${rule.section}.${key}`,
        ).not.toBe('prose')
      }
    }
  })

  it('the derivation never consults signals — the type-shaped need FALLBACK can never reach it', () => {
    // `buildProfileSignals` injects a type-shaped `signals.needs` fallback, so
    // that set is NEVER empty: John Doe's entire "need list"
    // (utilities/housing/food/healthcare/cash_assistance) was that fallback, and
    // reading it would make every profile "declare" items it never stated. This
    // module reads SECTIONS directly and must keep doing so.
    const src = readSource()
    expect(src).not.toMatch(/\bsignals\b/)
    expect(src).not.toMatch(/buildProfileSignals|profileHelpers/)
  })

  it('reads no field the schema marks drafting-only prose, by NAME either', () => {
    // Belt and braces: the canonical prose-name set, checked against the source.
    // `item_needs` is in `getUnscoredProseFieldNames()` because it is
    // scored:false — that is correct and expected, so it is excluded here; the
    // format assertion above is what actually pins it as non-prose.
    const proseNames = new Set(getUnscoredProseFieldNames())
    proseNames.delete('item_needs')
    const src = readCode()
    for (const name of proseNames) {
      expect(src, `reads prose field "${name}"`).not.toMatch(new RegExp(`\\.${name}\\b`))
    }
  })

  it('every rule id is unique and its source is declared or derived', () => {
    const ids = ITEM_NEED_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of ITEM_NEED_RULES) {
      expect(['declared', 'derived']).toContain(rule.source)
    }
  })

  it('every vocabulary entry produces a usable item and a search phrase', () => {
    // A vocabulary row with no `needText` would derive an item that the item
    // search could never look for — a list entry with no action behind it.
    const vocabs = { SUPPORT_NEED_ITEMS, DISABILITY_TYPE_ITEMS, HEALTH_FLAG_ITEMS, CREDENTIAL_ROLE_ITEMS, ITEM_TAG_VOCABULARY }
    for (const [name, vocab] of Object.entries(vocabs)) {
      for (const [key, entry] of Object.entries(vocab)) {
        expect(entry.item, `${name}.${key} has no item`).toBeTruthy()
        expect(entry.needText, `${name}.${key} has no needText`).toBeTruthy()
        expect(entry.category, `${name}.${key} has no category`).toBeTruthy()
      }
    }
  })

  it('HEALTH_FLAG_ITEMS is TOTAL over the canonical booleans it claims', () => {
    // Unlike free text, the flag set is finite — so it can be, and must be,
    // covered completely. A flag with no entry would be read and dropped.
    for (const key of Object.keys(HEALTH_FLAG_ITEMS)) {
      expect(PROFILE_SCHEMA.health_medical.fields[key], `health_medical.${key} is not a schema field`).toBeTruthy()
    }
  })
})

describe('profileItemNeeds — provenance', () => {
  it('every derived need carries the registry field id it came from', () => {
    const out = deriveProfileItemNeeds(JOHN_WHITE.profile, JOHN_WHITE.sections)
    expect(out.needs.length).toBeGreaterThan(0)
    const ruleIds = new Set(ITEM_NEED_RULES.map((r) => r.id))
    for (const need of out.needs) {
      expect(need.evidence, `${need.item} has no evidence`).toBeTruthy()
      expect(ruleIds.has(need.evidence), `${need.item} cites unknown field ${need.evidence}`).toBe(true)
      expect(need.need_text).toBeTruthy()
    }
  })

  it("Dr. White's RN declaration is what makes a licensure item appear", () => {
    const withRn = deriveProfileItemNeeds(JOHN_WHITE.profile, JOHN_WHITE.sections)
    const licence = withRn.needs.find((n) => n.evidence === 'occupation.credentialed_role')
    expect(licence).toBeTruthy()
    expect(licence.need_text).toMatch(/nursing/i)

    // MUTATION: remove the single declared fact and the item must vanish.
    const sections = { ...JOHN_WHITE.sections, occupation: { healthcare_worker_type: '' } }
    const without = deriveProfileItemNeeds(JOHN_WHITE.profile, sections)
    expect(without.needs.find((n) => n.evidence === 'occupation.credentialed_role')).toBeUndefined()
  })

  it("Focus Forward's ONE item comes from its own declared focus areas", () => {
    const out = deriveProfileItemNeeds(FOCUS_FORWARD.profile, FOCUS_FORWARD.sections)
    expect(out.needs.map((n) => n.item)).toEqual(['Building supplies and construction materials'])
    expect(out.needs[0].evidence).toBe('programs_services.focus_areas')

    // MUTATION: drop the declared tag and the list empties. An item list that
    // survives deleting the fact it came from is a checklist, not a derivation.
    const sections = {
      ...FOCUS_FORWARD.sections,
      programs_services: { ...FOCUS_FORWARD.sections.programs_services, focus_areas: ['Discipleship'], keywords: ['Sioux'] },
    }
    expect(deriveProfileItemNeeds(FOCUS_FORWARD.profile, sections).needs).toEqual([])
  })

  it('a mission word is never mistaken for an item', () => {
    const out = deriveProfileItemNeeds(FOCUS_FORWARD.profile, FOCUS_FORWARD.sections)
    const text = out.needs.map((n) => n.item).join(' ').toLowerCase()
    for (const mission of ['discipleship', 'poverty', 'empowerment', 'spiritual', 'outreach']) {
      expect(text, `mission word "${mission}" became an item`).not.toContain(mission)
    }
  })
})

describe('profileItemNeeds — applicability is read from the schema', () => {
  it('a person-only section never derives a need for an ORGANIZATION', () => {
    // Focus Forward carries imported `housing` and `health_medical` sections;
    // both are `applies_to: ALL_PERSON_TYPES`. A ministry must not be told it
    // needs a mobility aid or a household internet plan.
    const out = deriveProfileItemNeeds(FOCUS_FORWARD.profile, FOCUS_FORWARD.sections)
    expect(out.notApplicableFields).toContain('housing.broadband_speed')
    expect(out.notApplicableFields).toContain('health_medical.disability_type')
    const items = out.needs.map((n) => n.item).join(' ').toLowerCase()
    expect(items).not.toContain('internet')
    expect(items).not.toContain('adaptive')
  })

  it('the SAME sections DO derive for a person (the gate is not a blanket refusal)', () => {
    // Verify the verification: a gate that refuses everything proves nothing.
    const person = { primary_type: 'individual' }
    const out = deriveProfileItemNeeds(person, {
      housing: { broadband_speed: 'low' },
      health_medical: { disability_type: ['mobility'] },
    })
    const items = out.needs.map((n) => n.item).join(' ').toLowerCase()
    expect(items).toContain('internet')
    expect(items).toContain('mobility aid')
  })

  it('an UNKNOWN profile type loses nothing (missing = neutral)', () => {
    const out = deriveProfileItemNeeds({ primary_type: '' }, { health_medical: { disability_type: ['mobility'] } })
    expect(out.needs.length).toBe(1)
  })

  it('an UNRECOGNIZED type is neutral too — a ministry must not lose its own item list', () => {
    // Measured in prod 2026-08-02: `resolveEffectiveProfileType` resolves Focus
    // Forward to the FREE TEXT in `organization_details.organization_type` —
    // "Faith-based nonprofit ministry" — which neither
    // `canonicalizeProfileTypeId` nor `profileTypeRegistry.resolveProfileType`
    // can map. Reading "the registry does not know this type" as "this type is
    // excluded" cost the ministry `programs_services.focus_areas`, i.e. the one
    // item it actually declares. Losing a declared fact is strictly worse than
    // carrying an import artifact.
    const effective = { ...FOCUS_FORWARD.profile, primary_type: 'Faith-based nonprofit ministry' }
    const out = deriveProfileItemNeeds(effective, FOCUS_FORWARD.sections)
    expect(out.notApplicableFields).toEqual([])
    expect(out.needs.map((n) => n.item)).toContain('Building supplies and construction materials')
    expect(out.needs.find((n) => n.item === 'Building supplies and construction materials').evidence)
      .toBe('programs_services.focus_areas')
  })

  it('ruleAppliesToProfile follows PROFILE_SCHEMA, not a hand-typed flag', () => {
    const housingRule = ITEM_NEED_RULES.find((r) => r.id === 'housing.broadband_speed')
    expect(PROFILE_SCHEMA.housing.applies_to).toBeTruthy()
    expect(ruleAppliesToProfile(housingRule, 'individual')).toBe(true)
    expect(ruleAppliesToProfile(housingRule, 'nonprofit')).toBe(false)
    // A section with no applies_to applies to everyone.
    const freeText = ITEM_NEED_RULES.find((r) => r.id === 'financial_information.item_needs')
    expect(PROFILE_SCHEMA.financial_information.applies_to).toBeUndefined()
    expect(ruleAppliesToProfile(freeText, 'nonprofit')).toBe(true)
  })
})

describe('profileItemNeeds — precision', () => {
  it('a declared value that names no item becomes a CONVERGENT gap, not a guess', () => {
    const out = deriveProfileItemNeeds(JOHN_WHITE.profile, JOHN_WHITE.sections)
    const values = out.unmapped.map((u) => u.value)
    expect(values).toContain('CIPN')
    expect(values).toContain('unsteady gait')
    expect(values).toContain('access to healthcare services')
    // None of them became an item.
    const items = out.needs.map((n) => n.item.toLowerCase())
    expect(items.some((i) => i.includes('cipn'))).toBe(false)
    // Every gap names the ONE line that closes it.
    for (const gap of out.unmapped) {
      expect(gap.fix).toMatch(/profileItemNeeds\.js/)
      expect(gap.evidence).toBeTruthy()
    }
  })

  it('a vocabulary MISS on a mission tag is silent, not an unfillable ask', () => {
    // "Discipleship" resolving to no item must NOT ask the owner to add it to
    // an item vocabulary — that is the `lodging`-in-the-disease-lane class:
    // a nightly finding nobody can ever close.
    const out = deriveProfileItemNeeds(FOCUS_FORWARD.profile, FOCUS_FORWARD.sections)
    expect(out.unmapped.map((u) => u.value)).not.toContain('Discipleship')
  })

  it('token boundaries hold — a term must not match inside a longer word', () => {
    const out = deriveProfileItemNeeds({ primary_type: 'individual' }, {
      health_medical: { support_needs: ['transportational studies', 'foodie club'] },
    })
    // Neither declares the real need; both must be gaps, not items.
    expect(out.needs).toEqual([])
    expect(out.unmapped.length).toBe(2)
  })

  it('the list is BOUNDED and never a generic checklist', () => {
    const many = Array.from({ length: 40 }, (_, i) => `custom item ${i}`)
    const out = deriveProfileItemNeeds({ primary_type: 'individual' }, { financial_information: { item_needs: many } })
    expect(out.needs.length).toBe(MAX_ITEM_NEEDS)
    expect(out.truncated).toBe(40 - MAX_ITEM_NEEDS)
  })

  it('an EMPTY profile derives NOTHING (no default checklist)', () => {
    for (const type of ['individual', 'nonprofit', 'student', 'small_business']) {
      const out = deriveProfileItemNeeds({ primary_type: type }, {})
      expect(out.needs, `${type} got a default list`).toEqual([])
    }
  })
})

describe('the free-text item field', () => {
  it('is declared in BOTH registries', () => {
    expect(PROFILE_SCHEMA.financial_information.fields.item_needs).toBeTruthy()
    const meta = SECTION_METADATA.financial_information.fields.find((f) => f.name === 'item_needs')
    expect(meta, 'item_needs missing from sectionMetadata').toBeTruthy()
    expect(meta.format).toBe('string_array')
  })

  it('is NOT SCORED — it must not move any profile\'s match_score', () => {
    // `isFieldScored` defaults every PROFILE_SCHEMA field to SCORED, and
    // match_score is matched data points / TOTAL data points. Prod carries 37
    // real profiles that have never seen this box; scoring it would land in
    // every one of their denominators on deploy and shift rows across the
    // freshly-recalibrated bands.
    expect(isFieldScored(PROFILE_SCHEMA.financial_information.fields.item_needs)).toBe(false)
    const meta = SECTION_METADATA.financial_information.fields.find((f) => f.name === 'item_needs')
    expect(meta.scored).toBe(false)
  })

  it('is the STRONGEST evidence source — the owner\'s own words are never adjudicated', () => {
    const rule = ITEM_NEED_RULES[0]
    expect(rule.id).toBe('financial_information.item_needs')
    const out = deriveProfileItemNeeds({ primary_type: 'individual' }, {
      financial_information: { item_needs: ['PROBE Ethics class for nursing licensure'] },
    })
    expect(out.needs[0].item).toBe('PROBE Ethics class for nursing licensure')
    expect(out.needs[0].source).toBe('declared')
    expect(out.needs[0].need_text).toBe('PROBE Ethics class for nursing licensure')
  })

  it('an admin typing an item an org needs works the same way', () => {
    const out = deriveProfileItemNeeds(FOCUS_FORWARD.profile, {
      ...FOCUS_FORWARD.sections,
      financial_information: { item_needs: ['15 passenger van for reservation trips'] },
    })
    expect(out.needs.map((n) => n.item)).toContain('15 passenger van for reservation trips')
  })
})
