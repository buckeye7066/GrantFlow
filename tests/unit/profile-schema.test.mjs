import test from 'node:test'
import assert from 'node:assert/strict'

import { PROFILE_SCHEMA, supportedSectionKeys as schemaKeys } from '../../backend/config/profileSchema.js'
import { supportedSectionKeys as promptKeys } from '../../backend/prompts/profileSections.js'

test('profile schema: prompt section keys match canonical schema keys', () => {
  assert.deepEqual(new Set(promptKeys), new Set(schemaKeys))
})

test('profile schema: every field has an explanation + default', () => {
  for (const sectionKey of schemaKeys) {
    const section = PROFILE_SCHEMA[sectionKey]
    assert.ok(section, `missing section ${sectionKey}`)
    assert.ok(typeof section.title === 'string' && section.title.trim(), `missing title for ${sectionKey}`)
    assert.ok(
      typeof section.description === 'string' && section.description.trim(),
      `missing description for ${sectionKey}`,
    )

    const fields = section.fields || {}
    for (const [fieldKey, field] of Object.entries(fields)) {
      assert.ok(field, `missing field meta for ${sectionKey}.${fieldKey}`)
      assert.ok(
        typeof field.description === 'string' && field.description.trim(),
        `missing field description for ${sectionKey}.${fieldKey}`,
      )
      assert.ok(Object.prototype.hasOwnProperty.call(field, 'default'), `missing default for ${sectionKey}.${fieldKey}`)
      assert.ok(typeof field.type === 'string' && field.type.trim(), `missing type for ${sectionKey}.${fieldKey}`)
    }
  }
})

