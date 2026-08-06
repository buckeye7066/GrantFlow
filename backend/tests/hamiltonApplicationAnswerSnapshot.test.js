import { describe, expect, it } from 'vitest'
import {
  buildTargetScopedAnswerSnapshot,
  requiredFieldsMissingOrAmbiguous,
  resolveTargetUniversityApplication,
} from '../services/hamilton/hamiltonApplicationAnswerSnapshot.js'

const profile = {
  basic_information: { first_name: 'Avery', last_name: 'Rivera', email: 'avery@example.org' },
  university_applications: {
    applications: [
      {
        id: 'app-state',
        name: 'State University',
        major: 'Biology',
        student_id: 'STATE-1',
        website_url: 'https://state.example.edu',
        portals: { financial_aid: 'https://aid.state.example.edu/login' },
      },
      {
        id: 'app-city',
        name: 'City College',
        major: 'Public Health',
        student_id: 'CITY-2',
        website_url: 'https://city.example.edu',
        portals: { scholarships: 'https://awards.city.example.edu/apply' },
      },
    ],
  },
}

describe('target-scoped Hamilton answer snapshots', () => {
  it('selects the application bound to the current portal, not applications[0]', () => {
    const snapshot = buildTargetScopedAnswerSnapshot({
      profile,
      task: { id: 'task-city' },
      opportunity: { id: 'opp-city', institution_name: 'City College' },
      portalUrl: 'https://awards.city.example.edu/apply/2026',
    })

    expect(snapshot.target_application_id).toBe('app-city')
    expect(snapshot.values).toMatchObject({
      school: 'City College',
      major: 'Public Health',
      student_id: 'CITY-2',
    })
    expect(snapshot.provenance.student_id.source).toBe('university_application:app-city:student_id')
    expect(JSON.stringify(snapshot.provenance)).not.toContain('CITY-2')
  })

  it('fails closed when two application records are equally plausible', () => {
    const duplicated = {
      ...profile,
      university_applications: {
        applications: [
          { id: 'one', name: 'Twin College', major: 'Chemistry' },
          { id: 'two', name: 'Twin College', major: 'Physics' },
        ],
      },
    }
    const snapshot = buildTargetScopedAnswerSnapshot({
      profile: duplicated,
      opportunity: { institution_name: 'Twin College' },
      portalUrl: 'https://portal.example.org/apply',
    })

    expect(snapshot.target_application_status).toBe('ambiguous')
    expect(snapshot.values.school).toBeUndefined()
    expect(snapshot.conflicts[0]).toMatchObject({ kind: 'ambiguous_target_application' })
    expect(requiredFieldsMissingOrAmbiguous(snapshot, ['first_name', 'major'])).toEqual({
      ok: false,
      missing: ['major'],
      ambiguous: ['major'],
    })
  })

  it('does not borrow a lone unrelated application without a target match', () => {
    const one = {
      ...profile,
      university_applications: { applications: [profile.university_applications.applications[0]] },
    }
    const resolved = resolveTargetUniversityApplication(one, {
      opportunity: { institution_name: 'Different Institute' },
      portalUrl: 'https://different.example.edu/apply',
    })
    const snapshot = buildTargetScopedAnswerSnapshot({
      profile: one,
      opportunity: { institution_name: 'Different Institute' },
      portalUrl: 'https://different.example.edu/apply',
    })

    expect(resolved.status).toBe('unresolved')
    expect(snapshot.values.school).toBeUndefined()
    expect(snapshot.values.first_name).toBe('Avery')
  })

  it('freezes narratives and produces a deterministic hash with value-free provenance', () => {
    const args = {
      profile,
      opportunity: { institution_name: 'City College' },
      portalUrl: 'https://awards.city.example.edu/apply',
      narrativeAnswers: { essay: 'Target-specific essay' },
    }
    const first = buildTargetScopedAnswerSnapshot(args)
    const second = buildTargetScopedAnswerSnapshot(args)
    const changed = buildTargetScopedAnswerSnapshot({
      ...args,
      narrativeAnswers: { essay: 'Changed essay' },
    })

    expect(first.hash).toBe(second.hash)
    expect(first.hash).not.toBe(changed.hash)
    expect(first.values.essay).toBe('Target-specific essay')
    expect(first.provenance.essay).toEqual({ source: 'target_scoped_narrative:essay' })
  })
})
