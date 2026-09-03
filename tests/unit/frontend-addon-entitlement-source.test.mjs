import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('profile workspaces consume server-authoritative entitlement decisions', () => {
  const detail = read('src/pages/ProfileDetail.jsx')
  const overview = read('src/components/profiles/ProfileOverview.jsx')
  const organization = read('src/components/organizations/OrganizationProfile.jsx')

  assert.match(detail, /useTierEntitlements\(profileId\)/)
  assert.doesNotMatch(detail, /billing\?\.tier\?\.enable_document_ai/)

  assert.match(overview, /useTierEntitlements\(profile\?\.id \?\? null\)/)
  assert.doesNotMatch(overview, /billing\.tier\?\.enable_(?:pipeline_automation|item_funding|document_ai)/)

  assert.match(organization, /useTierEntitlements\(organizationId\)/)
  assert.match(organization, /disabled=\{!canPipelineAutomation\}/)
  assert.match(organization, /canDocumentAI=\{canDocumentAI\}/)
  assert.doesNotMatch(organization, /canDocumentAI=\{true\}/)
})
