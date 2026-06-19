/**
 * mapAIDataToApplicationPatch — locks the contract for the school-card AI
 * assist patch.
 *
 * The university applications section uses a SHALLOW merge ({...app, ...patch})
 * to apply the patch. Any nested object the AI populates (portals, theme,
 * costs) MUST therefore be pre-merged with the existing application's nested
 * object — otherwise updating one portal URL would clobber every other portal
 * URL the user previously entered.
 *
 * These tests prevent that regression and lock the new portal/theme keys the
 * AI assist now also returns (admissions, financial aid, scholarships,
 * housing, student portal, primary/secondary color, mascot, cheer line).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapAIDataToApplicationPatch } from '../../src/components/profiles/schoolCardAIAssistPatch.js'

describe('mapAIDataToApplicationPatch — admissions snapshot fields', () => {
  it('parses percent / currency / ratio fields onto application snake_case keys', () => {
    const patch = mapAIDataToApplicationPatch({
      acceptanceRate: '65%',
      avgGPA: '3.4',
      satRange: '1050-1250',
      tuition: '$28,900/yr',
      fafsaCode: '003510',
      graduationRate: '52%',
      studentTeacher: '14:1',
      avgClassSize: '18',
      estCost: '$38,200/yr',
      type: 'Public, Nonprofit',
    })
    assert.equal(patch.acceptance_rate, 0.65)
    assert.equal(patch.avg_gpa, 3.4)
    assert.equal(patch.sat_range, '1050-1250')
    assert.equal(patch.tuition, 28900)
    assert.equal(patch.fafsa_code, '003510')
    assert.equal(patch.graduation_rate, 0.52)
    assert.equal(patch.student_teacher_ratio, 14)
    assert.equal(patch.avg_class_size, 18)
    assert.equal(patch.costs.on_campus_total, 38200)
    assert.equal(patch.institution_type, 'public')
  })

  it('skips fields where the AI returned a literal "—"', () => {
    const patch = mapAIDataToApplicationPatch({
      acceptanceRate: '—', avgGPA: '—', satRange: '—', tuition: '—', estCost: '—',
    })
    assert.deepEqual(patch, {})
  })
})

describe('mapAIDataToApplicationPatch — portal URL deep-merge', () => {
  it('writes new portal URLs onto application.portals.*', () => {
    const patch = mapAIDataToApplicationPatch({
      admissionsUrl: 'https://www.mtsu.edu/how-to-apply/',
      financialAidUrl: 'https://www.mtsu.edu/financial-aid/',
      scholarshipsUrl: 'https://www.mtsu.edu/financial-aid/scholarships/',
      housingUrl: 'https://www.mtsu.edu/living-on-campus/',
      studentPortalUrl: 'https://www.mtsu.edu/pipelinemt/',
    })
    assert.equal(patch.portals.admissions_url, 'https://www.mtsu.edu/how-to-apply/')
    assert.equal(patch.portals.financial_aid_url, 'https://www.mtsu.edu/financial-aid/')
    assert.equal(patch.portals.scholarship_url, 'https://www.mtsu.edu/financial-aid/scholarships/')
    assert.equal(patch.portals.housing_url, 'https://www.mtsu.edu/living-on-campus/')
    assert.equal(patch.portals.student_portal_url, 'https://www.mtsu.edu/pipelinemt/')
  })

  it('preserves user-entered portal URLs (only fills empties)', () => {
    const existing = {
      portals: {
        admissions_url: 'https://my-custom-admissions-url.example/',
        financial_aid_url: '',
        student_portal_url: 'https://my-mymt.example/',
      },
    }
    const patch = mapAIDataToApplicationPatch({
      admissionsUrl: 'https://www.mtsu.edu/how-to-apply/',     // should NOT win
      financialAidUrl: 'https://www.mtsu.edu/financial-aid/',  // empty -> AI wins
      studentPortalUrl: 'https://www.mtsu.edu/pipelinemt/',    // already set -> NOT win
    }, existing)
    assert.equal(
      patch.portals.admissions_url, 'https://my-custom-admissions-url.example/',
      'user-entered URL must be preserved',
    )
    assert.equal(
      patch.portals.financial_aid_url, 'https://www.mtsu.edu/financial-aid/',
      'empty URL gets filled by AI',
    )
    assert.equal(
      patch.portals.student_portal_url, 'https://my-mymt.example/',
      'user-entered URL must be preserved',
    )
  })

  it('rejects garbage URLs (non-http(s) values are ignored)', () => {
    const patch = mapAIDataToApplicationPatch({
      admissionsUrl: 'not-a-url',
      financialAidUrl: '—',
      housingUrl: 'javascript:alert(1)',  // never accept
    })
    assert.equal(patch.portals, undefined, 'no portals patch for invalid URLs')
  })
})

describe('mapAIDataToApplicationPatch — theme deep-merge', () => {
  it('parses primary/secondary colors and the mascot/cheer line', () => {
    const patch = mapAIDataToApplicationPatch({
      primaryColor: '#0066CC',
      secondaryColor: 'FFFFFF',
      mascot: 'Lightning the Blue Raider',
      cheerLine: 'Go Blue Raiders!',
    })
    assert.equal(patch.theme.primary_color, '#0066CC')
    assert.equal(patch.theme.secondary_color, '#FFFFFF', 'normalises bare hex to a #-prefixed value')
    assert.equal(patch.theme.mascot, 'Lightning the Blue Raider')
    assert.equal(patch.theme.cheer_line, 'Go Blue Raiders!')
  })

  it('preserves user-customised theme values (only fills empties)', () => {
    const existing = {
      theme: {
        primary_color: '#990000', // user already picked
        secondary_color: '',
        cheer_line: 'My custom cheer',
      },
    }
    const patch = mapAIDataToApplicationPatch({
      primaryColor: '#0066CC',  // should NOT win
      secondaryColor: '#FFFFFF', // empty -> AI wins
      cheerLine: 'Go Blue Raiders!', // already set -> NOT win
    }, existing)
    assert.equal(patch.theme.primary_color, '#990000')
    assert.equal(patch.theme.secondary_color, '#FFFFFF')
    assert.equal(patch.theme.cheer_line, 'My custom cheer')
  })

  it('ignores invalid hex strings', () => {
    const patch = mapAIDataToApplicationPatch({
      primaryColor: 'not-a-color',
      secondaryColor: '—',
    })
    assert.equal(patch.theme, undefined)
  })
})

describe('mapAIDataToApplicationPatch — top-level website + costs', () => {
  it('only sets website_url when the application has none', () => {
    const patch1 = mapAIDataToApplicationPatch({ websiteUrl: 'https://www.mtsu.edu/' })
    assert.equal(patch1.website_url, 'https://www.mtsu.edu/')

    const patch2 = mapAIDataToApplicationPatch(
      { websiteUrl: 'https://www.mtsu.edu/' },
      { website_url: 'https://my-existing-site.example/' },
    )
    assert.equal(patch2.website_url, undefined, 'must not overwrite an existing website_url')
  })

  it('preserves other costs.* fields when only on_campus_total comes from AI', () => {
    const existing = { costs: { housing_preference: 'on_campus', off_campus_total: 12000 } }
    const patch = mapAIDataToApplicationPatch({ estCost: '$38,200/yr' }, existing)
    assert.equal(patch.costs.on_campus_total, 38200)
    assert.equal(patch.costs.housing_preference, 'on_campus')
    assert.equal(patch.costs.off_campus_total, 12000)
  })
})
