import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildOutputs,
  extractEnvVars,
} from '../../scripts/generate-env-examples.mjs'

const EXPECTED_RUNTIME_DEFAULTS = [
  '# CLAMAV_HOST=',
  '# CLAMAV_PORT=3310',
  '# CLAMAV_REQUIRED=false',
  '# CLAMAV_TIMEOUT_MS=10000',
  '# ERROR_REPORT_EMAIL=',
  '# ERROR_REPORT_LLM_ANALYSIS_ENABLED=false',
  '# NOFO_FETCH_MAX_BYTES=20971520',
  '# NOFO_FETCH_TIMEOUT_MS=20000',
  '# NOFO_PARSE_CHUNK_CHARS=14000',
  '# NOFO_PARSE_CHUNK_OVERLAP=600',
  '# NOFO_PARSE_MAX_TEXT_CHARS=2000000',
  '# PROFILE_SCORING_MAX_CANDIDATES=25000',
]

const SOURCE_CONTRACTS = [
  {
    path: '../../backend/utils/uploadFileValidation.js',
    names: ['CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_REQUIRED', 'CLAMAV_TIMEOUT_MS'],
  },
  {
    path: '../../backend/services/errorReporter.js',
    names: ['ERROR_REPORT_EMAIL', 'ERROR_REPORT_LLM_ANALYSIS_ENABLED'],
  },
  {
    path: '../../backend/routes/nofo.js',
    names: [
      'NOFO_FETCH_MAX_BYTES',
      'NOFO_FETCH_TIMEOUT_MS',
      'NOFO_PARSE_CHUNK_CHARS',
      'NOFO_PARSE_CHUNK_OVERLAP',
      'NOFO_PARSE_MAX_TEXT_CHARS',
    ],
  },
  {
    path: '../../backend/routes/opportunities.js',
    names: ['PROFILE_SCORING_MAX_CANDIDATES'],
  },
]

test('runtime sources remain traceable to the generated env contract', () => {
  for (const contract of SOURCE_CONTRACTS) {
    const names = extractEnvVars(readFileSync(new URL(contract.path, import.meta.url), 'utf8'))
    for (const name of contract.names) {
      assert.ok(names.has(name), `${contract.path} no longer references ${name}`)
    }
  }
})

test('generated and checked-in env examples preserve bounded upload, reporting, and NOFO defaults', () => {
  const { rootEnvExample, backendEnvExample } = buildOutputs()
  const checkedRoot = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
  const checkedBackend = readFileSync(new URL('../../backend/.env.example', import.meta.url), 'utf8')

  for (const line of EXPECTED_RUNTIME_DEFAULTS) {
    for (const [label, contents] of [
      ['generated root', rootEnvExample],
      ['generated backend', backendEnvExample],
      ['checked root', checkedRoot],
      ['checked backend', checkedBackend],
    ]) {
      assert.equal(
        contents.split('\n').filter((candidate) => candidate === line).length,
        1,
        `${label} must contain ${line} exactly once`,
      )
    }
  }
})
