/**
 * Unit tests for license reinstatement / PROBE / professional remediation funding support.
 * Tests that taxonomy, item parsing, curated sources, and match scoring
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
// TAXONOMY STRUCTURE
// ═══════════════════════════════════════════════════════════

test('TAXONOMY has license_reinstatement entry with correct canonical need', () => {
  assert.ok(TAXONOMY.license_reinstatement, 'license_reinstatement key should exist')
  assert.equal(TAXONOMY.license_reinstatement.canonicalNeed, 'license_reinstatement_support')
  assert.ok(TAXONOMY.license_reinstatement.programCategories.includes('license_reinstatement_support'))
  assert.ok(TAXONOMY.license_reinstatement.programCategories.includes('professional_remediation_funding'))
  assert.ok(TAXONOMY.license_reinstatement.programCategories.includes('nursing_reentry_support'))
  assert.ok(TAXONOMY.license_reinstatement.programCategories.includes('workforce_reentry_training'))
})

test('TAXONOMY license_reinstatement includes PROBE synonyms', () => {
  const syns = TAXONOMY.license_reinstatement.synonyms.map(s => s.toLowerCase())
  assert.ok(syns.some(s => s.includes('probe')), 'should include PROBE')
  assert.ok(syns.some(s => s.includes('ethics')), 'should include ethics')
  assert.ok(syns.some(s => s.includes('reinstatement')), 'should include reinstatement')
  assert.ok(syns.some(s => s.includes('remediation')), 'should include remediation')
  assert.ok(syns.some(s => s.includes('return to nursing')), 'should include return to nursing')
  assert.ok(syns.some(s => s.includes('professional boundaries')), 'should include professional boundaries')
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 1: PROBE ethics class for nursing reinstatement
// ═══════════════════════════════════════════════════════════

test('Case 1: "I need funding for the PROBE ethics class for nursing license reinstatement"', () => {
  const need = 'I need funding for the PROBE ethics class for nursing license reinstatement'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.equal(expanded.canonicalNeed, 'license_reinstatement_support',
    `canonical need should be license_reinstatement_support, got ${expanded.canonicalNeed}`)
  assert.ok(
    expanded.programCategories.includes('license_reinstatement_support'),
    `categories should include license_reinstatement_support, got: ${expanded.programCategories}`
  )
  assert.ok(
    expanded.programCategories.includes('professional_remediation_funding'),
    `categories should include professional_remediation_funding`
  )

  const ncsbnProbe = NATIONAL_PROGRAMS.find(p => p.id === 'np-probe-program-info')
  assert.ok(ncsbnProbe, 'PROBE program info should exist in nationalPrograms')
  const probeScore = scoreNeedMatch(ncsbnProbe, expanded)
  assert.ok(probeScore, 'PROBE program should score against this need')
  assert.ok(probeScore.score >= 25, `PROBE score should be >= 25, got ${probeScore.score}`)

  const wioaReinstate = NATIONAL_PROGRAMS.find(p => p.id === 'np-wioa-reinstatement-ita')
  assert.ok(wioaReinstate, 'WIOA reinstatement ITA should exist')
  const wioaScore = scoreNeedMatch(wioaReinstate, expanded)
  assert.ok(wioaScore, 'WIOA reinstatement should score against PROBE need')
  assert.ok(wioaScore.score >= 25, `WIOA reinstatement score should be >= 25, got ${wioaScore.score}`)

  const vocRehab = NATIONAL_PROGRAMS.find(p => p.id === 'np-vocational-rehab')
  const vrScore = scoreNeedMatch(vocRehab, expanded)
  assert.ok(vrScore, 'VR should score against PROBE reinstatement need')
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 2: Board-required ethics class to get license back
// ═══════════════════════════════════════════════════════════

test('Case 2: "I need help paying for a board-required ethics class so I can get my nursing license back"', () => {
  const need = 'I need help paying for a board-required ethics class so I can get my nursing license back'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['license_reinstatement_support', 'professional_remediation_funding', 'nursing_reentry_support',
       'workforce_reentry_training', 'employment', 'education'].includes(c)
    ),
    `should map to reinstatement/remediation categories, got: ${expanded.programCategories}`
  )

  const ajcReinstate = NATIONAL_PROGRAMS.find(p => p.id === 'np-ajc-reinstatement')
  assert.ok(ajcReinstate, 'AJC reinstatement program should exist')
  const ajcScore = scoreNeedMatch(ajcReinstate, expanded)
  assert.ok(ajcScore, 'AJC reinstatement should score for board-required ethics class need')
  assert.ok(ajcScore.score >= 20, `AJC score should be >= 20, got ${ajcScore.score}`)

  const hospitalSponsor = NATIONAL_PROGRAMS.find(p => p.id === 'np-hospital-reinstatement-sponsor')
  assert.ok(hospitalSponsor, 'Hospital reinstatement sponsorship should exist')
  const hospScore = scoreNeedMatch(hospitalSponsor, expanded)
  assert.ok(hospScore, 'Hospital sponsor should score for this need')
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 3: Professional remediation before returning to nursing
// ═══════════════════════════════════════════════════════════

test('Case 3: "I need financial assistance for a professional remediation course before I can return to nursing"', () => {
  const need = 'I need financial assistance for a professional remediation course before I can return to nursing'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['license_reinstatement_support', 'professional_remediation_funding', 'nursing_reentry_support'].includes(c)
    ),
    `should include reinstatement/remediation categories, got: ${expanded.programCategories}`
  )

  const ncsbnDiscipline = NATIONAL_PROGRAMS.find(p => p.id === 'np-ncsbn-discipline-resources')
  assert.ok(ncsbnDiscipline, 'NCSBN discipline resources should exist')
  const disciplineScore = scoreNeedMatch(ncsbnDiscipline, expanded)
  assert.ok(disciplineScore, 'NCSBN discipline should score for remediation need')
  assert.ok(disciplineScore.score >= 25, `NCSBN discipline score should be >= 25, got ${disciplineScore.score}`)

  // Verify it scores higher than a generic unrelated college scholarship
  const genericScholarship = {
    name: 'Generic College Merit Scholarship',
    description: 'Merit scholarship for undergraduate students based on GPA.',
    categories: ['scholarship', 'education'],
  }
  const genericScore = scoreNeedMatch(genericScholarship, expanded)
  const genericVal = genericScore?.score || 0
  assert.ok(disciplineScore.score > genericVal,
    `NCSBN discipline (${disciplineScore.score}) should score higher than generic scholarship (${genericVal})`)
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 4: Sponsor for reinstatement class
// ═══════════════════════════════════════════════════════════

test('Case 4: "I need someone to help sponsor my required reinstatement class"', () => {
  const need = 'I need someone to help sponsor my required reinstatement class'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(
    expanded.programCategories.some(c =>
      ['license_reinstatement_support', 'professional_remediation_funding', 'workforce_reentry_training'].includes(c)
    ),
    `should map to reinstatement categories, got: ${expanded.programCategories}`
  )

  const communityFound = NATIONAL_PROGRAMS.find(p => p.id === 'np-community-foundation-reinstatement')
  assert.ok(communityFound, 'Community foundation reinstatement program should exist')
  const cfScore = scoreNeedMatch(communityFound, expanded)
  assert.ok(cfScore, 'Community foundation should score for sponsorship need')

  const faithBased = NATIONAL_PROGRAMS.find(p => p.id === 'np-faith-community-reinstatement')
  assert.ok(faithBased, 'Faith-based reinstatement program should exist')
  const fbScore = scoreNeedMatch(faithBased, expanded)
  assert.ok(fbScore, 'Faith-based should score for sponsorship need')

  const civicClub = NATIONAL_PROGRAMS.find(p => p.id === 'np-civic-club-career-grant')
  assert.ok(civicClub, 'Civic club career grant should exist')
  const ccScore = scoreNeedMatch(civicClub, expanded)
  assert.ok(ccScore, 'Civic club should score for reinstatement sponsorship need')

  const employerTuition = NATIONAL_PROGRAMS.find(p => p.id === 'np-employer-tuition-reimbursement')
  assert.ok(employerTuition, 'Employer tuition reimbursement should exist')
  const etScore = scoreNeedMatch(employerTuition, expanded)
  assert.ok(etScore, 'Employer reimbursement should score for sponsorship need')
})

// ═══════════════════════════════════════════════════════════
// TEST CASE 5: Returning to healthcare after board-required course
// ═══════════════════════════════════════════════════════════

test('Case 5: "I need help returning to healthcare work after a board-required course"', () => {
  const need = 'I need help returning to healthcare work after a board-required course'
  const expanded = expandNeed(need)
  assert.ok(expanded, 'expandNeed should return a result')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')

  const hpog = NATIONAL_PROGRAMS.find(p => p.id === 'np-healthcare-workforce-reentry')
  assert.ok(hpog, 'Healthcare workforce reentry program should exist')
  const hpogScore = scoreNeedMatch(hpog, expanded)
  assert.ok(hpogScore, 'Healthcare workforce reentry should score for return-to-work need')

  const ana = NATIONAL_PROGRAMS.find(p => p.id === 'np-ana-reinstatement')
  assert.ok(ana, 'ANA reinstatement program should exist')
  const anaScore = scoreNeedMatch(ana, expanded)
  assert.ok(anaScore, 'ANA should score for return-to-healthcare need')

  const stateNurse = NATIONAL_PROGRAMS.find(p => p.id === 'np-state-nurse-assoc')
  assert.ok(stateNurse, 'State nurse association should exist')
  const snaScore = scoreNeedMatch(stateNurse, expanded)
  assert.ok(snaScore, 'State nurse association should score for return-to-work need')
})

// ═══════════════════════════════════════════════════════════
// CURATED SOURCE VALIDATION
// ═══════════════════════════════════════════════════════════

test('All reinstatement national programs have real URLs', () => {
  const programs = NATIONAL_PROGRAMS.filter(p =>
    (p.categories || []).includes('license_reinstatement_support') ||
    (p.categories || []).includes('nursing_reentry_support') ||
    (p.categories || []).includes('professional_remediation_funding')
  )
  assert.ok(programs.length >= 10, `Should have at least 10 reinstatement programs, found ${programs.length}`)
  for (const prog of programs) {
    assert.ok(prog.url, `Program "${prog.name}" must have a URL`)
    assert.ok(prog.url.startsWith('http'), `Program "${prog.name}" URL must start with http`)
    assert.ok(prog.id, `Program "${prog.name}" must have an id`)
  }
})

test('All reinstatement scholarships have real URLs', () => {
  const schols = SCHOLARSHIPS.filter(p =>
    (p.categories || []).includes('license_reinstatement_support') ||
    (p.categories || []).includes('nursing_reentry_support')
  )
  assert.ok(schols.length >= 3, `Should have at least 3 reinstatement scholarships, found ${schols.length}`)
  for (const s of schols) {
    assert.ok(s.url, `Scholarship "${s.name}" must have a URL`)
    assert.ok(s.url.startsWith('http'), `Scholarship "${s.name}" URL must start with http`)
  }
})

test('License reinstatement known item sources have valid entries', () => {
  const sources = KNOWN_ITEM_SOURCES.license_reinstatement || []
  assert.ok(sources.length >= 3, `Should have at least 3 license reinstatement sources, found ${sources.length}`)
  for (const src of sources) {
    assert.ok(src.url, `Source "${src.name}" must have a URL`)
    assert.ok(src.url.startsWith('http'), `Source "${src.name}" URL must start with http`)
    assert.ok(src.keywords?.length > 0, `Source "${src.name}" must have keywords`)
  }
})

// ═══════════════════════════════════════════════════════════
// VARIANT INPUT RECOGNITION
// ═══════════════════════════════════════════════════════════

test('expandNeed recognizes "PROBE class" directly', () => {
  const expanded = expandNeed('PROBE class')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.includes('license_reinstatement_support') ||
    expanded.programCategories.includes('professional_remediation_funding'),
    `PROBE class should map to reinstatement categories, got: ${expanded.programCategories}`
  )
})

test('expandNeed recognizes "nursing license reinstatement"', () => {
  const expanded = expandNeed('nursing license reinstatement')
  assert.ok(expanded, 'should expand')
  assert.equal(expanded.canonicalNeed, 'license_reinstatement_support')
})

test('expandNeed recognizes "ethics course required by board"', () => {
  const expanded = expandNeed('ethics course required by board of nursing')
  assert.ok(expanded, 'should expand')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')
})

test('expandNeed recognizes "remediation program"', () => {
  const expanded = expandNeed('funding for remediation program')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.some(c =>
      ['license_reinstatement_support', 'professional_remediation_funding', 'employment', 'education'].includes(c)
    ),
    `remediation should map to relevant categories, got: ${expanded.programCategories}`
  )
})

test('expandNeed recognizes "help paying for class to get my nursing license back"', () => {
  const expanded = expandNeed('I need help paying for the class to get my nursing license back')
  assert.ok(expanded, 'should expand')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')
})

test('expandNeed recognizes "return to practice requirement"', () => {
  const expanded = expandNeed('need support for required education before I can return to nursing')
  assert.ok(expanded, 'should expand')
  assert.ok(expanded.programCategories.length > 0, 'should have program categories')
})

test('expandNeed recognizes "professional boundaries course"', () => {
  const expanded = expandNeed('professional boundaries course funding')
  assert.ok(expanded, 'should expand')
  assert.ok(
    expanded.programCategories.some(c =>
      ['license_reinstatement_support', 'professional_remediation_funding'].includes(c)
    ),
    `professional boundaries should map to reinstatement, got: ${expanded.programCategories}`
  )
})

test('parseItemRequest detects license_reinstatement from free text', () => {
  const parsed1 = parseItemRequest('PROBE ethics class for nursing reinstatement')
  assert.ok(
    parsed1.categories.includes('license_reinstatement'),
    `should detect license_reinstatement from PROBE text, got: ${parsed1.categories}`
  )

  const parsed2 = parseItemRequest('nursing license reinstatement course')
  assert.ok(
    parsed2.categories.includes('license_reinstatement'),
    `should detect license_reinstatement from reinstatement text, got: ${parsed2.categories}`
  )

  const parsed3 = parseItemRequest('remediation course for board required education')
  assert.ok(
    parsed3.categories.includes('license_reinstatement'),
    `should detect license_reinstatement from remediation text, got: ${parsed3.categories}`
  )
})

// ═══════════════════════════════════════════════════════════
// FALSE POSITIVE GUARDS
// ═══════════════════════════════════════════════════════════

test('Reinstatement need does not match unrelated college scholarships', () => {
  const expanded = expandNeed('PROBE ethics class for nursing license reinstatement')
  const unrelated = {
    name: 'Generic College Academic Scholarship',
    description: 'Annual scholarship for undergraduate students based on GPA and extracurriculars.',
    categories: ['scholarship', 'education'],
  }
  const score = scoreNeedMatch(unrelated, expanded)
  const scoreVal = score?.score || 0

  const probeProgram = NATIONAL_PROGRAMS.find(p => p.id === 'np-probe-program-info')
  const probeScore = scoreNeedMatch(probeProgram, expanded)
  assert.ok(
    !probeScore || probeScore.score > scoreVal,
    `PROBE program (${probeScore?.score}) should score higher than generic scholarship (${scoreVal})`
  )
})

test('Reinstatement need does not match generic emergency rent aid', () => {
  const expanded = expandNeed('nursing license reinstatement course funding')
  const rentAid = {
    name: 'Emergency Rental Assistance Program',
    description: 'Emergency rent and utility assistance for households facing eviction.',
    categories: ['housing', 'cash_assistance'],
  }
  const score = scoreNeedMatch(rentAid, expanded)
  const scoreVal = score?.score || 0
  assert.ok(scoreVal < 20, `Emergency rent aid should score low (< 20) for reinstatement need, got ${scoreVal}`)
})

test('Reinstatement need does not match informational-only ethics resources', () => {
  const expanded = expandNeed('PROBE ethics class funding')
  const infoOnly = {
    name: 'Ethics Blog for Healthcare Workers',
    description: 'Blog articles about professional ethics in healthcare settings.',
    categories: ['healthcare'],
  }
  const score = scoreNeedMatch(infoOnly, expanded)
  const scoreVal = score?.score || 0

  const ncsbn = NATIONAL_PROGRAMS.find(p => p.id === 'np-ncsbn-discipline-resources')
  const ncsbnScore = scoreNeedMatch(ncsbn, expanded)
  assert.ok(
    !ncsbnScore || ncsbnScore.score > scoreVal,
    `NCSBN discipline resources (${ncsbnScore?.score}) should score higher than info-only blog (${scoreVal})`
  )
})
