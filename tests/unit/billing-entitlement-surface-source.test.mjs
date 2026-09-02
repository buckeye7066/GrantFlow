import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('catalog, billing API, and frontend read the same add-on capability vocabulary', () => {
  const catalog = read('shared/tierCatalog.js')
  const route = read('backend/routes/billing.js')
  const hook = read('src/hooks/useTierEntitlements.js')
  const api = read('src/api/billing.js')

  assert.match(catalog, /export const ADDON_CATALOG/)
  assert.match(catalog, /addons:\s*ADDON_CATALOG/)
  assert.match(route, /resolveAllProfileEntitlements/)
  assert.match(route, /\/me\/:profileId\/addons/)
  assert.match(route, /\/admin\/accounts\/:profileId\/addons/)
  assert.match(hook, /entitlements\?\.capabilities/)
  assert.match(api, /grantBillingAddon/)
  assert.match(api, /revokeBillingAddon/)
})

test('the API client recognizes every canonical entitlement denial class', () => {
  const source = read('src/api/client.js')
  for (const code of [
    'tier_or_addon_required',
    'payment_required',
    'profile_access_paused',
    'entitlement_authority_unavailable',
  ]) {
    assert.match(source, new RegExp(code))
  }
})
