import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import {
  buildProfileDataPointInventory,
  evaluateDataPointMatches,
} from '../services/profileDataPoints.js'

function organizationInventory(orgType) {
  return buildProfileDataPointInventory({
    profile: {
      id: `profile-${orgType.replace(/\W+/g, '-')}`,
      primary_type: 'organization',
      needs: ['capacity building'],
    },
    signals: {
      applicantType: 'organization',
      applicantTypes: new Set(['organization']),
      needs: new Set(['capacity building']),
      organization: { orgType },
      location: {},
      keywords: new Set(),
    },
    coverageNeeds: ['capacity building'],
  })
}

describe('Amy exact-SHA producer and identity contracts', () => {
  it('carries the canonical web-lane decision into every recommendation', () => {
    const source = fs.readFileSync(new URL('../crawler-os/webLane.js', import.meta.url), 'utf8')

    expect(source).toContain('decision: decision.decision')
    expect(source).toContain('match_decision: decision.decision')
  })

  it('promotes organization_details.organization_type into canonical signals once', () => {
    const signals = buildProfileSignals({
      profile: {
        id: 'profile-cdc',
        primary_type: 'nonprofit',
        needs: ['housing development'],
      },
      sections: {
        organization_details: {
          organization_type: 'community development corporation',
        },
      },
    })

    expect(signals.organization.orgType).toBe('community development corporation')

    const inventory = buildProfileDataPointInventory({
      profile: { id: 'profile-cdc', primary_type: 'nonprofit', needs: ['housing development'] },
      signals,
      coverageNeeds: ['housing development'],
    })
    const identityPoints = inventory.dataPoints.filter(
      (point) => point.value === 'community development corporation',
    )

    expect(identityPoints).toHaveLength(1)
    expect(identityPoints[0].kind).toBe('organization')
  })

  it.each([
    ['tribal government', 'Bureau of Indian Affairs funding for tribal nations and Native American communities'],
    ['community development corporation', 'HUD Community Development Block Grant CDBG funding for local development'],
    ['public housing authority', 'HUD Public Housing Capital Fund for eligible housing authorities'],
    ['workforce development board', 'WIOA workforce development and apprenticeship funding from the Employment and Training Administration'],
  ])('matches the %s identity through precise program vocabulary', (orgType, opportunityText) => {
    const inventory = organizationInventory(orgType)
    const result = evaluateDataPointMatches({
      inventory,
      oppText: opportunityText,
      oppSignals: [],
    })

    expect(result.matched.some((point) => point.kind === 'organization')).toBe(true)
    expect(result.credit).toBeGreaterThanOrEqual(1)
  })

  it('does not grant organization identity credit to an unrelated program', () => {
    const inventory = organizationInventory('public housing authority')
    const result = evaluateDataPointMatches({
      inventory,
      oppText: 'Biomedical laboratory research fellowship for graduate students',
      oppSignals: [],
    })

    expect(result.matched.some((point) => point.kind === 'organization')).toBe(false)
  })
})
