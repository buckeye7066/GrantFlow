/**
 * Owner directive 2026-09-05: "there should be a prepopulated list of items
 * that are known needs for the profile and Robert should already be able to
 * start searching for funding sources for those items automatically. A
 * nonprofit needing a 15-passenger van; an army vet in West Virginia starting
 * a food truck needs licenses, a truck, product, etc."
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  deriveOrgNeeds,
  declaresVenture,
  resolveBlueprint,
  getNeedDefinition,
  VENTURE_BLUEPRINT,
} from '../services/needs/orgNeedsTaxonomy.js'
import {
  runNeedsPlanAutoSearch,
  readNeedsPlanAutoSearch,
  selectAutoSearchNeeds,
} from '../services/needs/needsPlanAutoSearch.js'

const codes = (list) => list.map((n) => n.code)

describe('prepopulated item needs — the two owner examples', () => {
  it('a church whose programs transport youth is offered a 15-passenger van; one with no transport signal is not', () => {
    const transporting = deriveOrgNeeds({
      profile: { primary_type: 'church' },
      sections: { programs_services: { focus_areas: ['Youth ministry', 'Community outreach'], interests: ['field trips'] } },
    })
    expect(codes(transporting.open)).toContain('program_vehicle')
    const vehicle = transporting.open.find((n) => n.code === 'program_vehicle')
    expect(vehicle.search_subject).toMatch(/passenger van/i)

    const quiet = deriveOrgNeeds({ profile: { primary_type: 'church' }, sections: { organization_details: { mission: 'Sunday worship' } } })
    expect(codes(quiet.open)).not.toContain('program_vehicle')
    expect(codes(quiet.not_applicable)).toContain('program_vehicle')
  })

  it('a nonprofit already owning a van has the vehicle suppressed with the field as evidence', () => {
    const plan = deriveOrgNeeds({
      profile: { primary_type: 'nonprofit' },
      sections: {
        programs_services: { focus_areas: ['Meal delivery to seniors'] },
        organization_details: { equipment_owned: ['2019 Ford Transit 15 passenger van'] },
      },
    })
    const held = plan.suppressed.find((n) => n.code === 'program_vehicle')
    expect(held).toBeTruthy()
    expect(held.evidence.field).toBe('organization_details.equipment_owned')
  })

  it('a veteran (a PERSON) who declares a food-truck venture gets licences, the truck, a commissary, equipment, product and a POS', () => {
    const sections = {
      military_service: { veteran: true },
      basic_information: { state: 'WV', city: 'Beckley' },
      small_business_details: { business_name: "Sarge's Food Truck", naics_code: '722330', business_stage: 'planning' },
    }
    expect(declaresVenture(sections).declared).toBe(true)
    const blueprint = resolveBlueprint('veteran', sections)
    expect(blueprint.source).toBe('declared_venture')
    expect(blueprint.key).toBe('venture')

    const plan = deriveOrgNeeds({ profile: { primary_type: 'veteran' }, sections })
    const open = codes(plan.open)
    for (const code of ['mobile_food_unit', 'mobile_vendor_permits', 'business_licensing', 'commissary_kitchen', 'commercial_kitchen_equipment', 'inventory_product', 'pos_system', 'business_insurance', 'working_capital']) {
      expect(open, code).toContain(code)
    }
    // Every prepopulated item carries a concrete search subject Robert can run.
    for (const need of plan.open) expect(String(need.search_subject ?? '').trim().length).toBeGreaterThan(8)
  })

  it('a consulting startup is never offered a commissary kitchen or a food truck', () => {
    const plan = deriveOrgNeeds({
      profile: { primary_type: 'individual' },
      sections: { small_business_details: { business_name: 'Ridgeline Consulting LLC', business_type: 'consulting' } },
    })
    expect(plan.blueprint.source).toBe('declared_venture')
    const open = codes(plan.open)
    expect(open).toContain('business_licensing')
    expect(open).not.toContain('mobile_food_unit')
    expect(open).not.toContain('commissary_kitchen')
    expect(codes(plan.not_applicable)).toContain('mobile_food_unit')
  })

  it('a person who declares no venture still gets NO org plan (prose never declares one)', () => {
    const plan = deriveOrgNeeds({
      profile: { primary_type: 'individual' },
      sections: { narrative: { primary_goal: 'I dream of opening a food truck one day.' }, small_business_details: { notes: 'No small business details provided.' } },
    })
    expect(plan.blueprint.source).toBe('not_an_organization')
    expect(plan.open).toHaveLength(0)
  })

  it('every venture blueprint code has a definition', () => {
    for (const code of VENTURE_BLUEPRINT) expect(getNeedDefinition(code), code).toBeTruthy()
  })
})

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);')
  return db
}

describe('Robert searches the prepopulated list automatically', () => {
  it('runs the item search for the open needs after a crawl and persists the answer beside the plan', async () => {
    const db = makeDb()
    const calls = []
    const searchFn = async (_db, args) => {
      calls.push(args)
      return {
        items: args.items.map((it) => ({ lane: 'catalog', title: `Grant for ${it.item}`, item: it.item, code: it.code })),
        search_backends: { verdict: 'ok' },
      }
    }
    const profileContext = {
      profile: { id: 'p-truck', primary_type: 'veteran', display_name: 'Veteran' },
      sections: { small_business_details: { business_name: 'Mountain Smoke BBQ Truck', naics_code: '722330' }, military_service: { veteran: true } },
    }
    const record = await runNeedsPlanAutoSearch(db, { profileId: 'p-truck', profileContext, searchFn, maxNeeds: 5 })
    expect(calls).toHaveLength(1)
    expect(calls[0].items.length).toBe(5)
    expect(calls[0].blueprintKey).toBe('venture')
    expect(record.searched_count).toBe(5)
    expect(record.items.length).toBe(5)
    expect(record.remaining).toBeGreaterThan(0)

    const stored = await readNeedsPlanAutoSearch(db, 'p-truck')
    expect(stored.profile_id).toBe('p-truck')
    expect(stored.searched_needs.map((n) => n.code)).toEqual(calls[0].items.map((i) => i.code))
    expect(stored.result_counts.total).toBe(5)
  })

  it('a person with no plan records an honest empty run and searches nothing', async () => {
    const db = makeDb()
    let called = 0
    const record = await runNeedsPlanAutoSearch(db, {
      profileId: 'p-student',
      profileContext: { profile: { id: 'p-student', primary_type: 'student' }, sections: { education: { intended_major: 'Nursing' } } },
      searchFn: async () => { called += 1; return { items: [] } },
    })
    expect(called).toBe(0)
    expect(record.searched_count).toBe(0)
    expect(record.note).toMatch(/no prepopulated needs plan/i)
    expect(await readNeedsPlanAutoSearch(db, 'p-student')).toMatchObject({ searched_count: 0 })
  })

  it('a search failure is recorded, never thrown into the crawl', async () => {
    const db = makeDb()
    const record = await runNeedsPlanAutoSearch(db, {
      profileId: 'p-church',
      profileContext: { profile: { id: 'p-church', primary_type: 'church' }, sections: { programs_services: { focus_areas: ['Youth ministry'] } } },
      searchFn: async () => { throw new Error('search backend down') },
    })
    expect(record.note).toMatch(/search failed: search backend down/)
    expect(record.searched_count).toBe(0)
  })

  it('selectAutoSearchNeeds puts the blueprint list first, then the owner-typed items, deduped by subject', () => {
    const plan = {
      open: [{ code: 'a', label: 'A', search_subject: 'van grant', source: 'profile_type_blueprint' }, { code: 'b', label: 'B', search_subject: 'VAN GRANT', source: 'profile_type_blueprint' }],
      user_added: [{ label: 'my thing', search_subject: 'my thing funding' }],
    }
    const { selected, total } = selectAutoSearchNeeds(plan, { maxNeeds: 5 })
    expect(total).toBe(2)
    expect(selected.map((s) => s.source)).toEqual(['profile_type_blueprint', 'user_added'])
  })
})
