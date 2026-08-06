// Goal-1 invariants for the fundingResultsStore:
//   • getResultsForProfile(id) returns the empty view when the persisted
//     profile id does not match `id` strictly.
//   • Rehydration with a mismatched profile id (compared to the persisted
//     active profile id in localStorage) self-evicts the store within one
//     tick, so a hard reload after switching profiles never serves stale
//     results.

import test from 'node:test'
import assert from 'node:assert/strict'

// jsdom-flavoured localStorage for the rehydrate test
function makeMemoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
    _dump: () => Object.fromEntries(store),
  }
}

function setupStorage() {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {}
  }
  globalThis.window.localStorage = makeMemoryStorage()
  globalThis.localStorage = globalThis.window.localStorage
}

function teardownStorage() {
  delete globalThis.window
  delete globalThis.localStorage
}

test('fundingResultsStore — getResultsForProfile returns the empty view on profile mismatch', async () => {
  setupStorage()
  try {
    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=mismatch')
    useFundingResultsStore.getState().setResults({
      results: [{ id: 'opp-1', title: 'Test grant', match_score: 80 }],
      profileId: 'profile-demo_senior_family',
      organizationName: 'demo_senior_family',
      returned: 1,
      totalFound: 1,
    })
    const view = useFundingResultsStore.getState().getResultsForProfile('profile-someone-else')
    assert.deepEqual(view.results, [])
    assert.equal(view.profileId, null)
    assert.equal(view.returned, 0)
    assert.equal(view.totalFound, 0)
  } finally {
    teardownStorage()
  }
})

test('fundingResultsStore — getResultsForProfile returns the stored view on exact match', async () => {
  setupStorage()
  try {
    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=match')
    useFundingResultsStore.getState().setResults({
      results: [{ id: 'opp-1', title: 'Test grant', match_score: 80 }],
      profileId: 'profile-demo_senior_family',
      organizationName: 'demo_senior_family',
      returned: 1,
      totalFound: 1,
    })
    const view = useFundingResultsStore.getState().getResultsForProfile('profile-demo_senior_family')
    assert.equal(view.results.length, 1)
    assert.equal(view.results[0].id, 'opp-1')
    assert.equal(view.profileId, 'profile-demo_senior_family')
  } finally {
    teardownStorage()
  }
})

test('fundingResultsStore — carries zero-result ladder diagnostics through to the profile view (RC-12)', async () => {
  setupStorage()
  try {
    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=diagnostics')
    const diagnostics = {
      resultTier: 'DIRECTORY',
      tierExplanation: 'No verified direct grants; showing directory resources.',
      tierAttempts: [{ tier: 'STRONG_DIRECT', count: 0 }],
      profileGaps: ['location', 'entity_type'],
      directoryOnly: true,
      geoExpanded: false,
    }
    useFundingResultsStore.getState().setResults({
      results: [],
      profileId: 'profile-z',
      returned: 0,
      totalFound: 0,
      diagnostics,
    })
    const view = useFundingResultsStore.getState().getResultsForProfile('profile-z')
    assert.deepEqual(view.diagnostics, diagnostics)
    // And a profile mismatch must NOT leak diagnostics either.
    const other = useFundingResultsStore.getState().getResultsForProfile('profile-other')
    assert.equal(other.diagnostics, null)
  } finally {
    teardownStorage()
  }
})

test('fundingResultsStore — getResultsForProfile rejects null/undefined requested id', async () => {
  setupStorage()
  try {
    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=null')
    useFundingResultsStore.getState().setResults({
      results: [{ id: 'opp-1', title: 'X' }],
      profileId: 'profile-x',
      returned: 1,
      totalFound: 1,
    })
    assert.deepEqual(useFundingResultsStore.getState().getResultsForProfile(null).results, [])
    assert.deepEqual(useFundingResultsStore.getState().getResultsForProfile(undefined).results, [])
    assert.deepEqual(useFundingResultsStore.getState().getResultsForProfile('').results, [])
  } finally {
    teardownStorage()
  }
})

test('fundingResultsStore — rehydration with a mismatched active-profile-id evicts the store', async () => {
  setupStorage()
  try {
    globalThis.window.localStorage.setItem(
      'grantflow:active-profile-id',
      'profile-b',
    )
    globalThis.window.localStorage.setItem(
      'grantflow:funding-results',
      JSON.stringify({
        state: {
          results: [{ id: 'opp-stale', title: 'Stale grant', match_score: 90 }],
          profileId: 'profile-a',
          organizationName: 'A',
          organizationId: null,
          returned: 1,
          totalFound: 1,
          totalScored: 1,
          truncated: false,
          thresholdFallbackMessage: null,
        },
        version: 0,
      }),
    )

    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=rehydrate')

    // Zustand's persist middleware fires onRehydrateStorage synchronously
    // when the store is created in this environment; allow a microtask
    // turn so the deferred setState lands.
    await Promise.resolve()
    await Promise.resolve()

    const state = useFundingResultsStore.getState()
    assert.equal(state.profileId, null)
    assert.deepEqual(state.results, [])
    assert.equal(state.returned, 0)
  } finally {
    teardownStorage()
  }
})

test('fundingResultsStore — rehydration with a matching active-profile-id keeps the store', async () => {
  setupStorage()
  try {
    globalThis.window.localStorage.setItem(
      'grantflow:active-profile-id',
      'profile-keep',
    )
    globalThis.window.localStorage.setItem(
      'grantflow:funding-results',
      JSON.stringify({
        state: {
          results: [{ id: 'opp-fresh', title: 'Fresh grant', match_score: 70 }],
          profileId: 'profile-keep',
          organizationName: 'Keep',
          organizationId: null,
          returned: 1,
          totalFound: 1,
          totalScored: 1,
          truncated: false,
          thresholdFallbackMessage: null,
        },
        version: 0,
      }),
    )

    const { useFundingResultsStore } = await import('../../src/stores/fundingResultsStore.js?case=rehydrate-keep')
    await Promise.resolve()

    const state = useFundingResultsStore.getState()
    assert.equal(state.profileId, 'profile-keep')
    assert.equal(state.results.length, 1)
    assert.equal(state.results[0].id, 'opp-fresh')
  } finally {
    teardownStorage()
  }
})
