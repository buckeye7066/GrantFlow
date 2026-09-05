import test from 'node:test'
import assert from 'node:assert/strict'

import { declaredPopulationsFrom, profileContextToThesisInput } from '../../backend/services/crawlerOsPersistenceCore.js'
import { buildThesis } from '../../backend/crawler-os/profileIntelligence.js'
import { plan } from '../../backend/crawler-os/planner.js'

// Populations come from STRUCTURED facts only. A first-year student whose
// sections positively state no foster history, no military affiliation and no
// farm declares none of those populations, and the planner keeps the matching
// identity lanes closed for her (2026-09-05 live crawl finding).

const studentSections = {
  basic_information: { date_of_birth: '2008-07-19', state: 'TN', city: 'Cleveland' },
  education: { intended_major: 'Forensic Science', current_institution: 'Middle Tennessee State University' },
  employment: { current_status: 'Unemployed', notes: 'High school student focused on academics' },
  family_life: { caregiver: true, orphan: false, foster_youth: false, homeless: false, single_parent: false },
  military_service: { veteran: false, military_spouse: false, military_dependent: false, gold_star_family: false, notes: 'No military affiliation or documentation indicating veteran status.' },
  occupation: { farmer: false, educator: false, healthcare_worker: false, notes: 'Student focused on academics.' },
  demographics: { immigrant_status: 'unknown', languages: ['English', 'Russian'] },
  narrative: { primary_goal: 'Scholarships for forensic science; I want to help veterans and foster youth in my community one day.' },
}

test('a student with negative structured facts declares only caregiver (prose never adds a population)', () => {
  const populations = declaredPopulationsFrom({ sections: studentSections, signals: { family: new Set(['caregiver']) }, needs: ['education'] })
  assert.deepEqual(populations.sort(), ['caregiver'])
})

test('positive structured facts declare their populations', () => {
  const populations = declaredPopulationsFrom({
    sections: {
      family_life: { foster_youth: true, single_parent: true },
      military_service: { veteran: true },
      demographics: { immigrant_status: 'refugee', date_of_birth: '1950-01-01' },
      education: { intended_major: 'Paramedicine' },
      occupation: { farmer: true },
      employment: { career_goal: 'Elementary school teacher' },
    },
    signals: {},
    needs: [],
  })
  for (const p of ['foster_youth', 'parent_of_young_children', 'military_family', 'refugee', 'older_adult', 'health_professions_student', 'farmer', 'aspiring_teacher']) {
    assert.ok(populations.includes(p), `${p} declared (got ${populations.join(',')})`)
  }
  assert.ok(!populations.includes('survivor'))
})

test('the bridge carries declared_populations onto the thesis and the planner honours it', () => {
  const input = profileContextToThesisInput({
    profile: { id: 'student-b', primary_type: 'student', display_name: 'Student B' },
    sections: studentSections,
    signals: {
      applicantTypes: new Set(['student']),
      needs: new Set(['education', 'scholarship']),
      needs_structured: new Set(['education', 'scholarship']),
      family: new Set(['caregiver']),
      location: { state: 'TN', city: 'Cleveland', zip: '37312' },
      states: ['TN'],
    },
  })
  assert.deepEqual(input.declared_populations, ['caregiver'])
  const thesis = buildThesis(input)
  assert.deepEqual(thesis.declared_populations, ['caregiver'])
  const result = plan(thesis)
  const byId = new Map(result.source_decisions.map((d) => [d.source_id, d]))
  for (const id of ['fc2success_scholarships', 'acf_chafee_foster', 'orr_refugee', 'iraq_afghanistan_service_grant', 'operation_homefront', 'ssa_survivors', 'hslda_compassion_grants', 'farmers_gov_beginning_farmers', 'nea_neh_arts', 'dol_eta_workforce', 'teach_grant']) {
    const d = byId.get(id)
    assert.ok(d, `${id} decided`)
    assert.equal(d.selected, false, `${id} closed for this student (${d.reasons.join(',')})`)
  }
})
