#!/usr/bin/env node
import fs from 'node:fs'

const file = 'backend/services/profileHelpers.js'
const source = fs.readFileSync(file, 'utf8')
const duplicateKeywordRegistration = '  if (organizationType) registerKeyword(organizationType)\n'
const canonicalOrganizationSignal = '    orgType: organizationType,'

if (!source.includes(canonicalOrganizationSignal)) {
  throw new Error('[amy-organization-identity-dedupe] canonical organization signal is missing')
}

if (!source.includes(duplicateKeywordRegistration)) {
  console.log('[source-materialization] Amy organization identity already deduplicated')
  process.exit(0)
}

const first = source.indexOf(duplicateKeywordRegistration)
if (first !== source.lastIndexOf(duplicateKeywordRegistration)) {
  throw new Error('[amy-organization-identity-dedupe] duplicate keyword registration is ambiguous')
}

fs.writeFileSync(
  file,
  source.slice(0, first) + source.slice(first + duplicateKeywordRegistration.length),
)

console.log('[source-materialization] deduplicated Amy organization identity evidence')
