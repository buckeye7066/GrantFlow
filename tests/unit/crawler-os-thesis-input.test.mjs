import test from 'node:test'
import assert from 'node:assert/strict'

import { buildThesis } from '../../backend/crawler-os/profileIntelligence.js'
import { plan } from '../../backend/crawler-os/planner.js'
import { profileContextToThesisInput } from '../../backend/services/crawlerOsPersistence.js'

test('profileContextToThesisInput maps real needs separately from generic keywords', () => {
  const input = profileContextToThesisInput({
    profile: {
      id: 'profile-1',
      primary_type: 'student',
      interests: ['forensic science'],
      tags: ['senior'],
    },
    signals: {
      needs: new Set(['education', 'technology_equipment']),
      keywordSet: new Set(['display name token', 'generic funding']),
      location: { state: 'OH' },
      applicantTypes: new Set(['student']),
    },
    facets: {
      intent: {
        primary_need_category: 'education',
        keywords: ['scholarship'],
      },
    },
    normalized: {
      needCategories: ['education'],
    },
  })

  // Tags ('senior') are a keyword bag, not a need declaration, for the thesis.
  assert.deepEqual(input.need_categories.sort(), ['education', 'technology_equipment'])
  assert.ok(input.tags.includes('generic funding'))
  assert.ok(input.tags.includes('scholarship'))
  assert.ok(!input.need_categories.includes('generic funding'))
  assert.ok(!input.need_categories.includes('display name token'))
})

test('crawler thesis does not turn negative military fields into veteran startup needs', () => {
  const thesis = buildThesis({
    id: 'robert-like',
    profile_type: 'college_student',
    location: { state: 'TN' },
    description: 'College student seeking paramedicine training support and employment-related education help.',
    needs: ['paramedic training', 'employment', 'tuition'],
    sections: [
      {
        section_key: 'military_service',
        data: {
          is_veteran: false,
          veteran: 'no',
          veteran_status: 'false',
          active_duty: false,
          military_service: 'none',
          branch: 'not specified',
        },
      },
    ],
  })

  assert.ok(!thesis.applicant_types.includes('veteran'))
  assert.ok(!thesis.applicant_types.includes('active_duty'))
  assert.ok(!thesis.needs.includes('veterans'))
  assert.ok(!thesis.needs.includes('veteran_startup'))
  assert.ok(!thesis.needs.includes('military_startup'))
})

test('crawler plan does not select military-exclusive SBA startup sources for Robert-like student profile', () => {
  const thesis = buildThesis({
    id: 'robert-like',
    profile_type: 'college_student',
    location: { state: 'TN' },
    description: 'Robert is a college student pursuing paramedicine training and related employment.',
    needs: ['paramedic training', 'employment', 'tuition'],
  })
  const sourcePlan = plan(thesis)

  assert.ok(!sourcePlan.selected_source_ids.includes('sba_boots_to_business'))
  assert.ok(!sourcePlan.selected_source_ids.includes('sba_veteran_business'))
  assert.ok(!sourcePlan.selected_source_ids.includes('sba_vboc'))
})

test('ambiguous military background does not imply military-startup eligibility', () => {
  const thesis = buildThesis({
    id: 'ambiguous-military-background',
    profile_type: 'individual',
    location: { state: 'WV' },
    description: 'Single guy with a military background wants to start a food truck in West Virginia.',
    needs: ['food truck startup', 'kitchen equipment', 'working capital'],
  })

  assert.ok(thesis.needs.includes('startup'))
  assert.ok(thesis.needs.includes('equipment'))
  assert.ok(!thesis.needs.includes('military_startup'))
  assert.ok(!thesis.needs.includes('veteran_startup'))
})
