#!/usr/bin/env node
import fs from 'node:fs'

const file = 'backend/services/profileHelpers.js'
const source = fs.readFileSync(file, 'utf8')
const canonicalOrganizationSignal = '    orgType: organizationType,'

const duplicatedApplicantType = `  if (organizationDetails.organization_type) {
    registerKeyword(organizationDetails.organization_type)
    applicantTypeSet.add(normalizeString(organizationDetails.organization_type))
  }`

const deduplicatedApplicantType = `  if (organizationDetails.organization_type) {
    // Keep the specific organization identity available to discovery, but do
    // not count it again as a broad applicant-type fact. The dedicated
    // organization data point owns this evidence exactly once.
    registerKeyword(organizationDetails.organization_type)
  }`

const redundantKeywordRegistration = '  if (organizationType) registerKeyword(organizationType)\n'

if (!source.includes(canonicalOrganizationSignal)) {
  throw new Error('[amy-organization-identity-dedupe] canonical organization signal is missing')
}

let next = source

if (next.includes(duplicatedApplicantType)) {
  const first = next.indexOf(duplicatedApplicantType)
  if (first !== next.lastIndexOf(duplicatedApplicantType)) {
    throw new Error('[amy-organization-identity-dedupe] organization applicant-type block is ambiguous')
  }
  next = next.slice(0, first) + deduplicatedApplicantType + next.slice(first + duplicatedApplicantType.length)
} else if (!next.includes(deduplicatedApplicantType)) {
  throw new Error('[amy-organization-identity-dedupe] organization applicant-type block is missing')
}

if (next.includes(redundantKeywordRegistration)) {
  const first = next.indexOf(redundantKeywordRegistration)
  if (first !== next.lastIndexOf(redundantKeywordRegistration)) {
    throw new Error('[amy-organization-identity-dedupe] duplicate keyword registration is ambiguous')
  }
  next = next.slice(0, first) + next.slice(first + redundantKeywordRegistration.length)
}

if (next === source) {
  console.log('[source-materialization] Amy organization identity already deduplicated')
  process.exit(0)
}

fs.writeFileSync(file, next)
console.log('[source-materialization] deduplicated Amy organization identity evidence')
