import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileRoutes, classifyOwners } from '../../backend/services/hamilton/hamiltonCredentialOwnerRouter.js'

const ROUTES = compileRoutes([
  {
    profileId: 'p-robert',
    label: 'Robert White',
    match: {
      usernames: ['buckeye7066@gmail.com', 'rwhite08@clevelandstatecc.edu'],
      usernamePrefixes: ['firerookie', 'rwhite', 'buckeye'],
    },
  },
  {
    profileId: 'p-john',
    label: 'Dr. John White',
    match: {
      usernames: ['jwhiternmba@yahoo.com', 'johnw13', 'jwhite'],
      emailDomains: ['serenova.org'],
      keywords: ['johnwhite', 'jwhiternmba'],
    },
  },
  {
    profileId: 'p-anastasia',
    label: 'Anastasia Nicole White',
    match: { usernamePrefixes: ['anastasia', 'anyawhite', 'anw'] },
  },
  {
    profileId: 'p-axiom',
    label: 'Axiom BioLabs',
    match: { emailDomains: ['axiombiolabs.org'], hosts: ['axiombiolabs.org'], keywords: ['axiombiolabs'] },
  },
])

test('exact username match', () => {
  assert.deepEqual(classifyOwners({ username: 'buckeye7066@gmail.com' }, ROUTES), ['p-robert'])
})

test('username prefix match (case-insensitive)', () => {
  assert.deepEqual(classifyOwners({ username: 'FireRookie_74@yahoo.com' }, ROUTES), ['p-robert'])
  assert.deepEqual(classifyOwners({ username: 'rwhite08@clevelandstatecc.edu' }, ROUTES), ['p-robert'])
})

test('email-domain match', () => {
  assert.deepEqual(classifyOwners({ username: 'john@serenova.org' }, ROUTES), ['p-john'])
})

test('a credential can belong to two owners (person + org)', () => {
  // dr.johnwhite@axiombiolabs.org → John (keyword 'johnwhite') AND Axiom (email domain)
  assert.deepEqual(
    classifyOwners({ username: 'dr.johnwhite@axiombiolabs.org' }, ROUTES).sort(),
    ['p-axiom', 'p-john'],
  )
})

test('host match routes org logins', () => {
  assert.deepEqual(classifyOwners({ username: 'someone', host: 'portal.axiombiolabs.org' }, ROUTES), ['p-axiom'])
})

test('anastasia school + rocketmail identifiers', () => {
  assert.deepEqual(classifyOwners({ username: 'anw2aw@mtmail.mtsu.edu' }, ROUTES), ['p-anastasia'])
  assert.deepEqual(classifyOwners({ username: 'anyawhite@rocketmail.com' }, ROUTES), ['p-anastasia'])
})

test('ambiguous / unknown identifiers route to nobody (admin-vault-only)', () => {
  assert.deepEqual(classifyOwners({ username: 'sleepy_joe' }, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: 'blackjack02', host: 'www.dominos.com' }, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: '+1 4235047778' }, ROUTES), [])
})

test('compileRoutes tolerates @-prefixed domains and missing facets', () => {
  const c = compileRoutes([{ profileId: 'p', match: { emailDomains: ['@example.com'] } }])
  assert.deepEqual(classifyOwners({ username: 'x@example.com' }, c), ['p'])
})

test('empty / malformed inputs do not throw', () => {
  assert.deepEqual(classifyOwners({}, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: null, host: undefined }, ROUTES), [])
  assert.deepEqual(compileRoutes(null), [])
})
