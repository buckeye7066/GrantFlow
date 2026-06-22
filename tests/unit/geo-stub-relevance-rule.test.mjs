import test from 'node:test'
import assert from 'node:assert/strict'
import { isTemplatedGeoStub } from '../../backend/services/relevanceFilterRules.js'

test('templated geo-stubs are detected and rejected', () => {
  const stubs = [
    'United Way near Tryon, NC',
    'Community Action Agency near Benton, TN',
    'Food Bank resources near Cove, AR',
    'United Way of Franklin County',
    'Community Action Agency - Bradley County',
    'Salvation Army - Lorain County',
    'Volunteer Fire Department Grants - Van Buren County',
    'Bradley County Housing Authority',
  ]
  for (const title of stubs) {
    assert.equal(isTemplatedGeoStub({ title }), true, `should flag stub: ${title}`)
  }
})

test('real, specific local orgs and federal programs are NOT flagged', () => {
  const real = [
    'Catholic Charities – Lorain County Emergency Housing Assistance', // real, em-dash, not "- X County"
    'Salvation Army Lorain Corps – Emergency Rent & Housing Assistance', // real corps, not "- X County"
    'St. Mary Parish Helping Hands – Emergency Rent & Housing Assistance',
    'Assistance to Firefighters Grant (AFG)',
    'Tennessee Nursing Student Scholarship',
    'USDA Rural Development Community Facilities Grant',
  ]
  for (const title of real) {
    assert.equal(isTemplatedGeoStub({ title }), false, `should NOT flag real: ${title}`)
  }
})

test('honest directory records are exempt even if the title matches', () => {
  // The hardened county crawler emits these as honest directories — they must
  // pass as directories, not be rejected as fake direct opportunities.
  assert.equal(isTemplatedGeoStub({ title: 'Find your local United Way — Bradley County, TN', record_type: 'directory_resource' }), false)
  assert.equal(isTemplatedGeoStub({ title: 'United Way of Franklin County', opportunity_kind: 'DIRECTORY' }), false)
})
