import test from 'node:test'
import assert from 'node:assert/strict'

import { syncProfileFieldsFromSection } from '../../backend/utils/profileSectionSync.js'

test('syncProfileFieldsFromSection copies basic_information.full_name to profiles.display_name', () => {
  const runs = []
  const db = {
    prepare(sql) {
      return {
        run(...args) {
          runs.push({ sql, args })
        },
      }
    },
  }

  syncProfileFieldsFromSection(db, 'profile-1', 'basic_information', {
    full_name: 'Church of God of Prophecy International Offices',
  })

  assert.equal(runs.length, 1)
  assert.match(runs[0].sql, /display_name/)
  assert.equal(runs[0].args[0], 'Church of God of Prophecy International Offices')
  assert.equal(runs[0].args[1], 'profile-1')
})
