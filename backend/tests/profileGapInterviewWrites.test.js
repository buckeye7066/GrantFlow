/**
 * Every interview answer must be SAVEABLE, or the question is asked forever.
 *
 * Prod 2026-09-07 (owner: "still can't get it to accept this answer and move
 * on"): "Are you currently a student?" wrote education.is_student, the
 * section guard rejected it as unknown_field, nothing persisted, and the gap
 * plan asked the same question on every save. Four more answers had the same
 * hole (applicant_kind, population_served, mission_focus,
 * program_descriptions). This runs each question's answer through the REAL
 * guard so a new question cannot ship pointing at a field that does not exist.
 */
import { describe, it, expect } from 'vitest'
import { FACET_QUESTIONS, GAP_QUESTIONS, buildProfileGapPlan } from '../services/profileGapInterview.js'
import { guardProfileSectionPayload } from '../../shared/profileSuggestionGuards.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

const QUESTIONS = [...FACET_QUESTIONS, ...Object.values(GAP_QUESTIONS)]

describe('every interview answer lands in a declared field', () => {
  for (const q of QUESTIONS) {
    const w = q.writes
    if (!w) continue
    it(`${q.id} -> ${w.section}.${w.field} is accepted by the section guard (yes/no/text)`, () => {
      const samples = q.type === 'yes_no' ? [w.yes, w.no] : q.type === 'number' ? [5000] : ['sample answer']
      for (const value of samples) {
        const r = guardProfileSectionPayload({ [w.field]: value }, { profile: { primary_type: 'senior' }, sections: {}, sectionKey: w.section })
        const rejected = (r.rejected || []).filter((x) => x.reason !== 'normalized_alias')
        expect(rejected, `${q.id}=${JSON.stringify(value)} rejected: ${JSON.stringify(rejected)}`).toEqual([])
      }
    })
  }

  it('a saved "No" to the student question stops the question from being asked again', () => {
    const sections = { education: { is_student: false }, basic_information: { state: 'IN', city: 'Lagrange', zip_code: '46761' } }
    const n = normalizeProfile({ id: 'genemac', primary_type: 'senior' }, sections)
    const plan = buildProfileGapPlan(n, sections, { displayName: 'GeneMac', profile: { id: 'genemac', primary_type: 'senior' } })
    expect(plan.questions.map((q) => q.id)).not.toContain('is_student')
  })
})
