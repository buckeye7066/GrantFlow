import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialDirectoryAdapter } from '../adapters/officialDirectoryAdapter.js'
import { OPPORTUNITY_KIND } from '../contract.js'

test('directory title and facts are source-owned, never profile-shaped', () => {
  const adapter = createOfficialDirectoryAdapter('truth_directory')
  const source = {
    source_id: 'truth_directory',
    name: 'Tennessee Assistance Directory',
    resource_title: 'Tennessee Assistance Directory',
    title_prefix: 'Help for',
    base_url: 'https://example.org/resources',
    directory: true,
    applicant_types: ['individual'],
    need_categories: ['housing'],
    geography: { national: false, states: ['TN'] },
  }
  const [request] = adapter.buildRequests({ needs: ['medical debt'] }, source)
  assert.equal(request.parseCfg.directoryCandidate.title, 'Tennessee Assistance Directory')
  assert.equal(request.parseCfg.directoryCandidate.apply_url, null)
  const candidate = adapter.mapCandidate(request.parseCfg.directoryCandidate, { source })
  assert.equal(candidate.kind, OPPORTUNITY_KIND.DIRECTORY)
  assert.equal(candidate.is_directory, true)
  assert.equal(candidate.apply_url, null)
  assert.equal(candidate.info_url, source.base_url)
})

test('a standing program base page is information, not an invented apply link', () => {
  const adapter = createOfficialDirectoryAdapter('standing_program')
  const source = {
    source_id: 'standing_program',
    name: 'Standing Assistance Program',
    base_url: 'https://example.org/program',
    directory: false,
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
  }
  const [request] = adapter.buildRequests({}, source)
  const candidate = adapter.mapCandidate(request.parseCfg.directoryCandidate, { source })
  assert.equal(candidate.kind, OPPORTUNITY_KIND.PROGRAM)
  assert.equal(candidate.info_url, source.base_url)
  assert.equal(candidate.apply_url, null)
})

test('an explicit registry application URL remains actionable', () => {
  const adapter = createOfficialDirectoryAdapter('actionable_program')
  const source = {
    source_id: 'actionable_program',
    name: 'Actionable Program',
    base_url: 'https://example.org/program',
    application_url: 'https://example.org/program/apply',
    directory: false,
    default_kinds: [OPPORTUNITY_KIND.PROGRAM],
  }
  const [request] = adapter.buildRequests({}, source)
  const candidate = adapter.mapCandidate(request.parseCfg.directoryCandidate, { source })
  assert.equal(candidate.apply_url, source.application_url)
  assert.equal(candidate.info_url, source.base_url)
})
