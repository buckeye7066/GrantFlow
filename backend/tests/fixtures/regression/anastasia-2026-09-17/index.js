/**
 * Sanitized production capture, 2026-09-17, deployed commit a91267ac.
 *
 * One live Tennessee student profile and the catalog + match rows behind the
 * result-quality defects attributed that day (see capture-meta.json `cases`).
 * Identity was removed (names, contacts, essays, avatars); every eligibility
 * fact is verbatim. The capture was read-only (default_transaction_read_only).
 */
import { readFileSync } from 'node:fs'

const here = new URL('./', import.meta.url)

function readJson(name) {
  return JSON.parse(readFileSync(new URL(name, here), 'utf8'))
}

export const FIXTURE_PROFILE_ID = 'fixture-profile-tn-student-2026-09-17'

export const CASE_IDS = Object.freeze({
  jacksonvilleNoGeo: '390af12b5100b725e19303770e28ce0a8c94dd9d68b416fb5d65983cf6115501',
  jacksonvilleNc: '3b0a363eb84ddfb632bc599a16d98443023ce62d7e677553a50879069f3cec9a',
  ecfCaregiverStipend: '1143d9e4941dcaf3d77c39b355eb55a37979cbf4649953f2ba3f946b06068d15',
  hcbsWaivers: '3a0924a3f13e346cdd89b7300a42bc52b6a142cc19f9a1270580efa15663a044',
  ecfParent: 'c5f66900663ecf3fa20162f13d29d287c70a7ab0d35f2c6c85fcd084452e75c9',
  internationalMeritCatalogRescore: '3c90e9fe8dcda0333c00ac91253e729e9360ecc4e88efa95abab23dfd59e319a',
  internationalMeritInstitution: '2bc34ce76948e2822e5346ce54627a962cb76a169949588bfc8d0d12ef1ba4d8',
  internationalMeritsProgram: '628f42eca166aae3f4482c3dfd97423179429a389fa8ee25459da3e40bf090cd',
})

export function loadRegressionFixture() {
  const { profile, sections } = readJson('profile.json')
  const opportunities = readJson('opportunities.json')
  const matches = readJson('matches.json')
  const meta = readJson('capture-meta.json')
  return {
    profile,
    /** Array of { section_key, data } exactly as profile_sections stores them. */
    sections,
    /** Object keyed by section_key — the shape loadProfileContext produces. */
    sectionsByKey: Object.fromEntries(sections.map((s) => [s.section_key, s.data])),
    opportunities,
    matches,
    meta,
    opportunityById: (id) => opportunities.find((o) => o.id === id),
    matchByOpportunityId: (id) => matches.find((m) => m.opportunity_id === id),
    parseExplain: (match) => {
      const raw = match?.match_explain_json
      if (!raw) return null
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    },
  }
}

export default loadRegressionFixture
