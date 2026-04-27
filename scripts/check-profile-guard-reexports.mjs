#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const wrappers = [
  'src/utils/profileSuggestionGuards.js',
  'backend/utils/profileSuggestionGuards.js',
]
const forbidden = [
  'HOUSEHOLD_EVIDENCE',
  'BENEFIT_BASES',
  'OCCUPATION_FLAGS',
  'isHighSchoolProfile',
  'hasEmployerEvidence',
  'dedupeLongText',
  'guardProfileSectionPayload',
  'guardProfileSectionSuggestion',
]

let failed = false
for (const file of wrappers) {
  const fullPath = path.join(root, file)
  const source = readFileSync(fullPath, 'utf8')
  const reExportOnly = /^\s*export\s+\*\s+from\s+['"].*shared\/profileSuggestionGuards\.js['"]\s*;?\s*$/.test(source)
  const localDeclarations = forbidden.filter((token) =>
    new RegExp(`\\b(?:const|let|var|function)\\s+${token}\\b|\\bexport\\s+function\\s+${token}\\b`).test(source),
  )

  if (!reExportOnly || localDeclarations.length > 0) {
    failed = true
    console.error(
      `[profile-guard-check] ${file} must only re-export shared/profileSuggestionGuards.js. Local logic: ${
        localDeclarations.join(', ') || 'unexpected content'
      }`,
    )
  }
}

if (failed) process.exit(1)
