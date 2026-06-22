/**
 * Unit tests for CPR / First Aid / AED / Instructor Certification funding support.
 * Tests that the taxonomy, item parsing, curated sources, and match scoring
 * properly handle the 5 specified user need scenarios.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const taxonomyPath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'shared', 'needTaxonomy.js')
const itemCrawlerPath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'crawlers', 'itemFundingCrawler.js')
const nationalPath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'shared', 'data', 'nationalPrograms.js')
const scholarshipsPath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'shared', 'data', 'scholarships.js')

const taxonomyMod = await import(pathToFileURL(taxonomyPath).href)
const { expandNeed, scoreNeedMatch } = taxonomyMod
const TAXONOMY = taxonomyMod.default.TAXONOMY
const { parseItemRequest, KNOWN_ITEM_SOURCES } = await import(pathToFileURL(itemCrawlerPath).href)
const { default: NATIONAL_PROGRAMS } = await import(pathToFileURL(nationalPath).href)
const { default: SCHOLARSHIPS } = await import(pathToFileURL(scholarshipsPath).href)

// ═══════════════════════════════════════════════════════════
// TAXONOMY EXPANSION TESTS
// ═══════════════════════════════════════════════════════════

test('TAXONOMY has cpr_first_aid entry', () => {
  assert.ok(TAXONOMY.cpr_first_aid, 'cpr_first_aid key should exist in TAXONOMY')
  assert.equal(TAXONOMY.cpr_first_aid.canonicalNeed, 'certification_assistance')
  assert.ok(TAXONOMY.cpr_first_aid.programCategories.includes('certification_assistance'))
  assert.ok(TAXONOMY.cpr_first_aid.programCategories.includes('cpr_first_aid_training'))
})

test('TAXONOMY has safety_certification entry', () => {
  assert.ok(TAXONOMY.safety_certification, 'safety_certification key should exist in TAXONOMY')
  assert.equal(TAXONOMY.safety_certification.canonicalNeed, 'certification_assistance')
  assert.ok(TAXONOMY.safety_certification.programCategories.includes('community_health_training'))
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 1: CPR instructor class for church teaching
// ═══════════════════════════════════════════════════════════

test('Case 1: "I need help paying for a CPR instructor class so I can teach at my church"', () => {
  const need = 'I need help paying for a CPR instructor class so I can teach at my church'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(expanded.canonicalNeed, 'should have a canonical need')
  assert.ok(
    expanded.programCategories.includes('certification_assistance') ||
    expanded.programCategories.includes('cpr_first_aid_training') ||
    expanded.programCategories.includes('community_health_training'),
    `categories should include cert/cpr/community, got: ${expanded.programCategories}`
  )

  const churchProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-church-benevolence-training')
  assert.ok(churchProgram, 'church benevolence program should exist in nationalPrograms')
  const churchScore = scoreNeedMatch(churchProgram, expanded)
  assert.ok(churchScore, 'church benevolence should score against CPR instructor need')
  assert.ok(churchScore.score >= 20, `church benevolence score should be >= 20, got ${churchScore.score}`)

  const wioaProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-wioa-certification-vouchers')
  assert.ok(wioaProgram, 'WIOA certification vouchers should exist')
  const wioaScore = scoreNeedMatch(wioaProgram, expanded)
  assert.ok(wioaScore, 'WIOA should score against CPR instructor need')
  assert.ok(wioaScore.score >= 20, `WIOA score should be >= 20, got ${wioaScore.score}`)
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 2: First Aid/CPR certification for employment
// ═══════════════════════════════════════════════════════════

test('Case 2: "I need financial help for First Aid/CPR certification for employment"', () => {
  const need = 'I need financial help for First Aid/CPR certification for employment'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.includes('certification_assistance') ||
    expanded.programCategories.includes('cpr_first_aid_training') ||
    expanded.programCategories.includes('employment') ||
    expanded.programCategories.includes('workforce_training'),
    `categories should include cert/employment/workforce, got: ${expanded.programCategories}`
  )

  const ajcProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-ajc-cpr-training')
  assert.ok(ajcProgram, 'American Job Center CPR training program should exist')
  const ajcScore = scoreNeedMatch(ajcProgram, expanded)
  assert.ok(ajcScore, 'AJC should score against First Aid/CPR employment need')
  assert.ok(ajcScore.score >= 25, `AJC score should be >= 25, got ${ajcScore.score}`)

  const wioaProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-wioa-certification-vouchers')
  const wioaScore = scoreNeedMatch(wioaProgram, expanded)
  assert.ok(wioaScore, 'WIOA should score against employment CPR need')
  assert.ok(wioaScore.score >= 25, `WIOA score should be >= 25, got ${wioaScore.score}`)
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 3: Teaching CPR/First Aid in the community
// ═══════════════════════════════════════════════════════════

test('Case 3: "I want to become certified to teach CPR and First Aid in the community"', () => {
  const need = 'I want to become certified to teach CPR and First Aid in the community'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['certification_assistance', 'cpr_first_aid_training', 'community_health_training'].includes(c)
    ),
    `categories should include cert/cpr/community, got: ${expanded.programCategories}`
  )

  const rotaryProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-rotary-community-grants')
  assert.ok(rotaryProgram, 'Rotary community grants program should exist')
  const rotaryScore = scoreNeedMatch(rotaryProgram, expanded)
  assert.ok(rotaryScore, 'Rotary should score against community CPR teaching need')
  assert.ok(rotaryScore.score >= 20, `Rotary score should be >= 20, got ${rotaryScore.score}`)

  const hospitalProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-hospital-education-cpr')
  assert.ok(hospitalProgram, 'Hospital education CPR program should exist')
  const hospitalScore = scoreNeedMatch(hospitalProgram, expanded)
  assert.ok(hospitalScore, 'Hospital program should produce a score object against community teaching need')
  assert.ok(hospitalScore.score >= 20, `Hospital education CPR score should be >= 20, got ${hospitalScore.score}`)

  const ahaProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-aha-community-training')
  assert.ok(ahaProgram, 'AHA community training program should exist')
  const ahaScore = scoreNeedMatch(ahaProgram, expanded)
  assert.ok(ahaScore, 'AHA should produce a score object against community CPR teaching need')
  assert.ok(ahaScore.score >= 20, `AHA community training score should be >= 20, got ${ahaScore.score}`)
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 4: BLS/Heartsaver instructor course funding
// ═══════════════════════════════════════════════════════════

test('Case 4: "I need a low-cost or funded BLS/Heartsaver instructor course"', () => {
  const need = 'I need a low-cost or funded BLS/Heartsaver instructor course'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'employment', 'education'].includes(c)
    ),
    `categories should include cert/cpr categories, got: ${expanded.programCategories}`
  )

  const parsed = parseItemRequest(need)
  assert.ok(
    parsed.categories.includes('cpr_certification') ||
    parsed.categories.includes('instructor_certification') ||
    parsed.categories.includes('training'),
    `parseItemRequest categories should include cpr/instructor/training, got: ${parsed.categories}`
  )

  const hasCprSources = KNOWN_ITEM_SOURCES.cpr_certification?.length > 0
  assert.ok(hasCprSources, 'KNOWN_ITEM_SOURCES should have cpr_certification entries')

  const hasInstructorSources = KNOWN_ITEM_SOURCES.instructor_certification?.length > 0
  assert.ok(hasInstructorSources, 'KNOWN_ITEM_SOURCES should have instructor_certification entries')
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 5: Ministry CPR training need
// ═══════════════════════════════════════════════════════════

test('Case 5: "Our ministry wants someone trained to teach CPR"', () => {
  const need = 'Our ministry wants someone trained to teach CPR'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'volunteer_training_support'].includes(c)
    ),
    `categories should include cert/cpr/community/volunteer, got: ${expanded.programCategories}`
  )

  const churchProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-church-benevolence-training')
  assert.ok(churchProgram, 'church benevolence program should exist')
  const churchScore = scoreNeedMatch(churchProgram, expanded)
  assert.ok(churchScore, 'church benevolence should score against ministry CPR need')
  assert.ok(churchScore.score >= 20, `church score should be >= 20, got ${churchScore.score}`)

  const communityFoundation = NATIONAL_PROGRAMS.find(p => p.id === 'np-community-foundation-safety')
  assert.ok(communityFoundation, 'community foundation safety program should exist')
  const cfScore = scoreNeedMatch(communityFoundation, expanded)
  assert.ok(cfScore, 'community foundation should produce a score object against ministry CPR need')
  assert.ok(cfScore.score >= 20, `Community foundation safety score should be >= 20, got ${cfScore.score}`)
})

// ═══════════════════════════════════════════════════════════
// CURATED SOURCE VALIDATION
// ═══════════════════════════════════════════════════════════

test('All CPR national programs have real URLs', () => {
  const cprPrograms = NATIONAL_PROGRAMS.filter(p =>
    (p.categories || []).includes('certification_assistance') ||
    (p.categories || []).includes('cpr_first_aid_training')
  )
  assert.ok(cprPrograms.length >= 10, `Should have at least 10 CPR-related programs, found ${cprPrograms.length}`)
  for (const prog of cprPrograms) {
    assert.ok(prog.url, `Program "${prog.name}" must have a URL`)
    assert.ok(prog.url.startsWith('http'), `Program "${prog.name}" URL must start with http`)
    assert.ok(prog.id, `Program "${prog.name}" must have an id`)
  }
})

test('All CPR scholarships have real URLs', () => {
  const cprScholarships = SCHOLARSHIPS.filter(p =>
    (p.categories || []).includes('certification_assistance') ||
    (p.categories || []).includes('cpr_first_aid_training')
  )
  assert.ok(cprScholarships.length >= 3, `Should have at least 3 CPR-related scholarships, found ${cprScholarships.length}`)
  for (const s of cprScholarships) {
    assert.ok(s.url, `Scholarship "${s.name}" must have a URL`)
    assert.ok(s.url.startsWith('http'), `Scholarship "${s.name}" URL must start with http`)
  }
})

test('CPR known item sources have valid entries', () => {
  const cprSources = KNOWN_ITEM_SOURCES.cpr_certification || []
  const instructorSources = KNOWN_ITEM_SOURCES.instructor_certification || []
  assert.ok(cprSources.length >= 3, `Should have at least 3 CPR certification sources, found ${cprSources.length}`)
  assert.ok(instructorSources.length >= 2, `Should have at least 2 instructor sources, found ${instructorSources.length}`)
  for (const src of [...cprSources, ...instructorSources]) {
    assert.ok(src.url, `Source "${src.name}" must have a URL`)
    assert.ok(src.url.startsWith('http'), `Source "${src.name}" URL must start with http`)
    assert.ok(src.keywords?.length > 0, `Source "${src.name}" must have keywords`)
  }
})

// ═══════════════════════════════════════════════════════════
// VARIANT INPUT RECOGNITION
// ═══════════════════════════════════════════════════════════

test('expandNeed recognizes "CPR class" directly', () => {
  const expanded = expandNeed('CPR class')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.includes('certification_assistance') ||
    expanded.programCategories.includes('cpr_first_aid_training'),
    `CPR class should map to cert categories, got: ${expanded.programCategories}`
  )
})

test('expandNeed recognizes "first aid certification"', () => {
  const expanded = expandNeed('first aid certification')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.includes('certification_assistance') ||
    expanded.programCategories.includes('cpr_first_aid_training'),
    `first aid cert should map to cert categories, got: ${expanded.programCategories}`
  )
})

test('expandNeed recognizes "BLS instructor training"', () => {
  const expanded = expandNeed('BLS instructor training')
  assert.ok(expanded, 'should expand')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')
})

test('expandNeed recognizes "need grant for training to teach community CPR"', () => {
  const expanded = expandNeed('need grant for training to teach community CPR')
  assert.ok(expanded, 'should expand')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')
})

test('expandNeed recognizes "need funding for safety certification"', () => {
  const expanded = expandNeed('need funding for safety certification')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.some(c =>
      ['certification_assistance', 'cpr_first_aid_training', 'community_health_training', 'employment', 'education'].includes(c)
    ),
    `safety cert should map to relevant categories, got: ${expanded.programCategories}`
  )
})

test('parseItemRequest detects CPR-related categories from free text', () => {
  const parsed1 = parseItemRequest('CPR instructor certification')
  assert.ok(
    parsed1.categories.includes('cpr_certification') || parsed1.categories.includes('instructor_certification'),
    `should detect cpr/instructor category from "CPR instructor certification", got: ${parsed1.categories}`
  )

  const parsed2 = parseItemRequest('first aid class')
  assert.ok(
    parsed2.categories.includes('cpr_certification') || parsed2.categories.includes('training'),
    `should detect cpr/training from "first aid class", got: ${parsed2.categories}`
  )

  const parsed3 = parseItemRequest('BLS Heartsaver instructor course')
  assert.ok(
    parsed3.categories.includes('cpr_certification') || parsed3.categories.includes('instructor_certification'),
    `should detect cpr/instructor from "BLS Heartsaver", got: ${parsed3.categories}`
  )
})

// ═══════════════════════════════════════════════════════════
// FALSE POSITIVE GUARDS
// ═══════════════════════════════════════════════════════════

test('CPR need does not match unrelated college scholarships', () => {
  const expanded = expandNeed('CPR instructor certification')
  const unrelatedScholarship = {
    name: 'Generic College Merit Scholarship',
    description: 'Merit scholarship for undergraduate students based on GPA and test scores.',
    categories: ['scholarship', 'education'],
  }
  const score = scoreNeedMatch(unrelatedScholarship, expanded)
  const scoreVal = score?.score || 0
  assert.ok(scoreVal < 30, `Unrelated scholarship should score low (< 30), got ${scoreVal}`)
})

test('CPR need does not match AED equipment-only grants', () => {
  const expanded = expandNeed('CPR certification class funding')
  const aedEquipment = {
    name: 'AED Equipment Placement Grant',
    description: 'Grant to purchase and install AED defibrillator units in public buildings. Equipment only, no training included.',
    categories: ['equipment', 'healthcare'],
  }
  const score = scoreNeedMatch(aedEquipment, expanded)
  const scoreVal = score?.score || 0
  const cprProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-aha-community-training')
  assert.ok(cprProgram, 'np-aha-community-training must exist in NATIONAL_PROGRAMS for this false-positive guard to be meaningful')
  const cprScore = scoreNeedMatch(cprProgram, expanded)
  assert.ok(cprScore, 'AHA community training should produce a score object')
  assert.ok(
    cprScore.score > scoreVal,
    `CPR training program (score: ${cprScore.score}) should score higher than AED-equipment-only grant (score: ${scoreVal})`
  )
})
