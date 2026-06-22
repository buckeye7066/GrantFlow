import test from 'node:test'
import assert from 'node:assert/strict'
import { RELEVANCE_RULES } from '../../backend/services/relevanceFilterRules.js'

// Evaluate the relevance rules the way relevanceFilter.js does:
// a rule applies (reject) when (oppPattern null OR matches oppText) AND profileCheck(pd, oppText, opp).
function rejects(ruleId, oppText, pd, opp = {}) {
  const rule = RELEVANCE_RULES.find((r) => r.id === ruleId)
  assert.ok(rule, `rule ${ruleId} exists`)
  const patternMatches = rule.oppPattern == null || rule.oppPattern.test(oppText)
  return patternMatches && rule.profileCheck(pd, oppText, { title: oppText, ...opp })
}

test('foreign/embassy programs are rejected for domestic profiles', () => {
  const church = { primary_type: 'church' }
  assert.equal(rejects('foreign_embassy_program', 'Mission Italy Annual Program Statement 2023', church), true)
  assert.equal(rejects('foreign_embassy_program', 'U.S. Mission to the United Arab Emirates — Lunar Payload Design Challenge', church), true)
  // A normal domestic grant is untouched.
  assert.equal(rejects('foreign_embassy_program', 'Tennessee Community Food Assistance Grant', church), false)
})

test('research-institution mechanisms are rejected for non-research profiles', () => {
  const church = { primary_type: 'church' }
  const individual = { primary_type: 'individual' }
  const university = { primary_type: 'university' }
  assert.equal(rejects('research_institution_only', 'Research Resource for a National Swine Resource and Research Center (U42)', church), true)
  assert.equal(rejects('research_institution_only', 'Faith-Based HIV Prevention for Women — National Institute on Minority Health', church), true)
  assert.equal(rejects('research_institution_only', 'Forecast NIH R01 Research Project Grant', individual), true)
  // A real research institution keeps them.
  assert.equal(rejects('research_institution_only', 'Research Resource (U42) Swine Resource Center', university), false)
  // A normal local grant is untouched.
  assert.equal(rejects('research_institution_only', 'Emergency Rent & Housing Assistance — Salvation Army', church), false)
})

test('tribal-only programs are rejected for non-tribal profiles', () => {
  const individual = { primary_type: 'individual' }
  const tribe = { primary_type: 'tribal_government' }
  assert.equal(rejects('tribal_government_only', 'FY2026 Support for 988 Tribal Response Cooperative Agreements', individual), true)
  assert.equal(rejects('tribal_government_only', 'Indian Tribes Public Safety Grant', individual), true)
  assert.equal(rejects('tribal_government_only', 'FY2026 Support for 988 Tribal Response Cooperative Agreements', tribe), false)
  assert.equal(rejects('tribal_government_only', 'Tennessee Nursing Student Scholarship', individual), false)
})
