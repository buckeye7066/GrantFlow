import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileRoutes, classifyOwners } from '../../backend/services/hamilton/hamiltonCredentialOwnerRouter.js'

const ROUTES = compileRoutes([
  {
    profileId: 'p-student-driver',
    label: 'Demo Student Driver',
    match: {
      usernames: ['student.driver@example.invalid', 'student.driver@school.example.invalid'],
      usernamePrefixes: ['studentdriver', 'driverstudent', 'demo-driver'],
    },
  },
  {
    profileId: 'p-health-educator',
    label: 'Demo Health Educator',
    match: {
      usernames: ['educator@example.invalid', 'educator13', 'healthdemo'],
      emailDomains: ['healthdemo.example.invalid'],
      keywords: ['healtheducator', 'healthdemo'],
    },
  },
  {
    profileId: 'p-stem-student',
    label: 'Demo Tennessee STEM Student',
    match: { usernamePrefixes: ['demostem', 'studentstem', 'dstem'] },
  },
  {
    profileId: 'p-axiom',
    label: 'Axiom BioLabs',
    match: { emailDomains: ['axiombiolabs.org'], hosts: ['axiombiolabs.org'], keywords: ['axiombiolabs'] },
  },
])

test('exact username match', () => {
  assert.deepEqual(classifyOwners({ username: 'student.driver@example.invalid' }, ROUTES), ['p-student-driver'])
})

test('username prefix match is case-insensitive', () => {
  assert.deepEqual(classifyOwners({ username: 'StudentDriver_74@example.invalid' }, ROUTES), ['p-student-driver'])
  assert.deepEqual(classifyOwners({ username: 'student.driver@school.example.invalid' }, ROUTES), ['p-student-driver'])
})

test('email-domain match', () => {
  assert.deepEqual(classifyOwners({ username: 'person@healthdemo.example.invalid' }, ROUTES), ['p-health-educator'])
})

test('a credential can belong to two owners: person plus org', () => {
  assert.deepEqual(
    classifyOwners({ username: 'healtheducator@axiombiolabs.org' }, ROUTES).sort(),
    ['p-axiom', 'p-health-educator'],
  )
})

test('host match routes org logins', () => {
  assert.deepEqual(classifyOwners({ username: 'someone', host: 'portal.axiombiolabs.org' }, ROUTES), ['p-axiom'])
})

test('student school plus personal identifiers', () => {
  assert.deepEqual(classifyOwners({ username: 'dstem2@mtmail.mtsu.edu' }, ROUTES), ['p-stem-student'])
  assert.deepEqual(classifyOwners({ username: 'studentstem@example.invalid' }, ROUTES), ['p-stem-student'])
})

test('ambiguous or unknown identifiers route to nobody', () => {
  assert.deepEqual(classifyOwners({ username: 'sleepy_joe' }, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: 'blackjack02', host: 'www.dominos.com' }, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: '+1 5550100000' }, ROUTES), [])
})

test('compileRoutes tolerates @-prefixed domains and missing facets', () => {
  const c = compileRoutes([{ profileId: 'p', match: { emailDomains: ['@example.com'] } }])
  assert.deepEqual(classifyOwners({ username: 'x@example.com' }, c), ['p'])
})

test('empty or malformed inputs do not throw', () => {
  assert.deepEqual(classifyOwners({}, ROUTES), [])
  assert.deepEqual(classifyOwners({ username: null, host: undefined }, ROUTES), [])
  assert.deepEqual(compileRoutes(null), [])
})
