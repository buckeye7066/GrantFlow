import { expect, it } from 'vitest'
import { buildAmyTags } from '../services/amy/amyMetadata.js'
import { buildThesis } from '../crawler-os/profileIntelligence.js'

it('keeps every actual Amy trace marker out of crawler topics without coupling Crawler OS to Amy', () => {
  const tags = buildAmyTags({ runId: 'run-1', scenarioId: 'student-v1' })
  const markers = [...tags, ...tags.map(tag => tag.replace(/_/g, ' '))]
  const thesis = buildThesis({ profile_type: 'student', tags: [...markers, 'public health'] })
  expect(thesis.interest_terms).toContain('public health')
  for (const marker of markers) expect(thesis.interest_terms).not.toContain(marker)
})
