#!/usr/bin/env node
/**
 * crawler-system-verify.mjs
 *
 * Crawler OS verification harness. This script intentionally audits the current
 * canonical engine under backend/crawler-os only. It must not import the retired
 * strategy registry, domain engines, or National Crawler V2.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { allSources } from '../backend/crawler-os/sourceRegistry.js'
import { getAdapter, implementedAdapterIds } from '../backend/crawler-os/adapters/index.js'
import { createMemoryStore } from '../backend/crawler-os/store.js'
import { runDiscovery } from '../backend/crawler-os/pipeline.js'
import { buildThesis } from '../backend/crawler-os/profileIntelligence.js'
import { storage } from '../backend/crawler-os/index.js'
import {
  makeOpportunity,
  OPPORTUNITY_KIND,
  REALITY_STATUS,
  TRUST_TIER,
} from '../backend/crawler-os/contract.js'
import {
  makeOfflineFetcher,
  SAMPLE_STUDENT_PROFILE,
  SAMPLE_VFD_PROFILE,
} from '../backend/crawler-os/tests/fixtures/fakeFetch.mjs'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const outDir = path.join(repoRoot, 'test-results')
const command = 'node scripts/crawler-system-verify.mjs'

const LEGACY_IMPORT_PATTERNS = [
  /backend\/services\/crawlers\//,
  /strategyRegistry\.js/,
  /domainEngines\//,
  /nationalCrawlerV2\//,
  /backend\/services\/sourceRegistry\.js/,
]

function verifyOwnImports() {
  const source = fs.readFileSync(__filename, 'utf8')
  const importLines = source
    .split(/\r?\n/)
    .filter((line) => /^\s*import\s/.test(line))
    .join('\n')
  return LEGACY_IMPORT_PATTERNS
    .filter((pattern) => pattern.test(importLines))
    .map((pattern) => String(pattern))
}

function verifyRegistry() {
  const sources = allSources()
  const adapterIds = implementedAdapterIds()
  const sourceIds = new Set(sources.map((source) => source.source_id))
  const adapterSet = new Set(adapterIds)
  const issues = []

  for (const source of sources) {
    const adapter = getAdapter(source.source_id)
    if (!adapter) {
      issues.push({ source_id: source.source_id, issue: 'missing_adapter' })
      continue
    }
    // The directory-family adapter is kind-aware: a `directory:false` registry
    // row emits its honest `default_kinds[0]` (BENEFIT/SCHOLARSHIP/PROGRAM/…)
    // and only falls back to DIRECTORY when no default kind is declared. Flag
    // ONLY the misconfiguration where a non-directory row would still emit a
    // DIRECTORY kind — not every non-directory source served by this adapter.
    if (
      adapter.family === 'directory' &&
      source.directory !== true &&
      (!(source.default_kinds || []).length || source.default_kinds[0] === OPPORTUNITY_KIND.DIRECTORY)
    ) {
      issues.push({ source_id: source.source_id, issue: 'adapter_emits_directory_but_registry_directory_false' })
    }
    if (source.directory && !(source.default_kinds || []).includes(OPPORTUNITY_KIND.DIRECTORY)) {
      issues.push({ source_id: source.source_id, issue: 'directory_source_default_kind_not_directory' })
    }
    if (!source.base_url || !/^https:\/\//i.test(source.base_url)) {
      issues.push({ source_id: source.source_id, issue: 'base_url_missing_or_not_https' })
    }
  }

  for (const adapterId of adapterIds) {
    if (!sourceIds.has(adapterId)) issues.push({ source_id: adapterId, issue: 'adapter_without_registry_row' })
  }

  return {
    source_count: sources.length,
    adapter_count: adapterIds.length,
    missing_adapters: sources.filter((source) => !adapterSet.has(source.source_id)).map((source) => source.source_id),
    extra_adapters: adapterIds.filter((id) => !sourceIds.has(id)),
    issues,
    sources: sources.map((source) => ({
      source_id: source.source_id,
      name: source.name,
      source_type: source.source_type,
      directory: Boolean(source.directory),
      default_kinds: source.default_kinds || [],
      adapter_present: adapterSet.has(source.source_id),
      adapter_family: getAdapter(source.source_id)?.family || null,
    })),
  }
}

function catalogViolations(store) {
  const violations = []
  for (const row of storage.listCatalog(store)) {
    const kind = String(row.kind || '')
    const directish = ![OPPORTUNITY_KIND.DIRECTORY, OPPORTUNITY_KIND.PAST_AWARD_INTEL].includes(kind)
    if (directish && !row.apply_url && !row.info_url) {
      violations.push({ id: row.id, title: row.title, issue: 'direct_row_without_apply_or_info_url' })
    }
    if (kind === OPPORTUNITY_KIND.DIRECTORY && row.apply_url) {
      violations.push({ id: row.id, title: row.title, issue: 'directory_has_apply_url' })
    }
    if (row.is_loan) {
      violations.push({ id: row.id, title: row.title, issue: 'loan_stored_as_funding_result' })
    }
  }
  return violations
}

async function runProfileMatrix() {
  const profiles = [
    { key: 'vfd', profile: SAMPLE_VFD_PROFILE },
    { key: 'student', profile: SAMPLE_STUDENT_PROFILE },
  ]
  const results = []
  const failures = []

  for (const item of profiles) {
    const store = createMemoryStore()
    const thesis = buildThesis(item.profile)
    const run = await runDiscovery(
      { store, fetcher: makeOfflineFetcher(), env: {}, clock: () => 1_786_000_000_000 },
      { thesis, matchProfiles: [thesis], runId: `verify_${item.key}` },
    )
    const matches = storage.getMatchesForProfile(store, thesis.profile_id)
    const violations = catalogViolations(store)
    if (item.key === 'vfd' && run.stored < 1) failures.push({ profile: item.key, issue: 'expected_at_least_one_stored_row' })
    if (item.key === 'vfd' && matches.length < 1) failures.push({ profile: item.key, issue: 'expected_at_least_one_profile_match' })
    failures.push(...violations.map((v) => ({ profile: item.key, ...v })))
    results.push({
      profile: item.key,
      thesis: {
        profile_id: thesis.profile_id,
        applicant_types: thesis.applicant_types,
        needs: thesis.needs,
        location: thesis.location,
      },
      planned: run.planned,
      stored_or_existing: run.stored,
      rejected: run.rejected,
      recommendations: run.recommendations.length,
      zero_result_reason: run.zero_result?.zero_result_reason || null,
      sources: run.sources.map((source) => ({
        source_id: source.source_id,
        outcome: source.outcome,
        reason: source.reason || null,
        fetched: source.fetched,
        parsed: source.parsed,
        stored: source.stored,
        existing: source.existing || 0,
        deduped: source.deduped || 0,
      })),
      catalog_count: storage.countOpportunities(store),
      match_count: matches.length,
      catalog_violations: violations,
    })
  }

  return { results, failures }
}

async function verifyExistingRowsStillMatch() {
  const store = createMemoryStore()
  const thesis = buildThesis(SAMPLE_VFD_PROFILE)
  const canonicalId = 'verify-existing-canonical'
  const applyUrl = 'https://www.grants.gov/search-results-detail/OPP-7777'
  storage.upsertOpportunity(store, makeOpportunity({
    id: canonicalId,
    source_id: 'seeded_catalog',
    external_id: 'OPP-7777',
    kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Volunteer Fire Equipment Grant',
    sponsor: 'FEMA',
    summary: 'Funding for volunteer fire department emergency equipment.',
    apply_url: applyUrl,
    info_url: applyUrl,
    applicant_types: ['vfd'],
    need_categories: ['equipment', 'emergency'],
    geography: { national: true, states: [] },
    funding: { amount_max: 50000 },
    reality_status: REALITY_STATUS.VERIFIED,
    trust_tier: TRUST_TIER.OFFICIAL_API,
  }))

  const run = await runDiscovery(
    {
      store,
      fetcher: makeOfflineFetcher({
        grantsGov: [{
          id: 'OPP-7777',
          title: 'Volunteer Fire Equipment Grant',
          agency: 'FEMA',
          agencyCode: 'DHS-FEMA',
          summary: 'Funding for volunteer fire department emergency equipment.',
          closeDate: '12/31/2026',
        }],
        fail: new Set(['cof.org', 'benefits.gov', 'sam.gov', 'federalregister.gov', 'grants.nih.gov']),
      }),
      env: {},
      clock: () => 1_786_000_000_000,
    },
    { thesis, matchProfiles: [thesis], runId: 'verify_existing_rows_match' },
  )
  const matches = storage.getMatchesForProfile(store, thesis.profile_id)
  const matchedExisting = matches.some((match) => match.opportunity_id === canonicalId)
  // The intent of this check is DEDUP + RE-MATCH: the re-crawled grants_gov
  // item must collapse into the seeded canonical row (never a second direct
  // row) and the profile must still match it. Honest DIRECTORY locator rows
  // from other planned sources are by-design survivors (see pipeline.js) and
  // must not fail the check — so assert on the non-directory rows, not on the
  // total catalog count.
  const directRows = storage.listCatalog(store).filter((row) => row.kind !== OPPORTUNITY_KIND.DIRECTORY)
  const onlyCanonicalDirect = directRows.length === 1 && directRows[0].id === canonicalId
  return {
    passed: matchedExisting && onlyCanonicalDirect && !run.zero_result,
    catalog_count: storage.countOpportunities(store),
    direct_row_count: directRows.length,
    only_canonical_direct: onlyCanonicalDirect,
    match_count: matches.length,
    matched_existing: matchedExisting,
    zero_result_reason: run.zero_result?.zero_result_reason || null,
    source_existing_total: run.sources.reduce((sum, source) => sum + Number(source.existing || 0), 0),
  }
}

function toMarkdown(report) {
  const lines = []
  lines.push('# Crawler OS Verification Report', '')
  lines.push(`Generated: ${report.generated_at}`)
  lines.push(`Command: \`${command}\``, '')
  lines.push('## Surface')
  lines.push(`- sources: ${report.registry.source_count}`)
  lines.push(`- adapters: ${report.registry.adapter_count}`)
  lines.push(`- registry issues: ${report.registry.issues.length}`)
  lines.push(`- forbidden verifier imports: ${report.forbidden_imports.length}`, '')
  lines.push('## Profile Matrix')
  for (const result of report.profile_matrix.results) {
    lines.push(`- ${result.profile}: planned=${result.planned}, stored_or_existing=${result.stored_or_existing}, matches=${result.match_count}, zero=${result.zero_result_reason || 'none'}`)
  }
  lines.push('', '## Repeat Run')
  lines.push(`- passed: ${report.repeat_existing.passed}`)
  lines.push(`- catalog_count: ${report.repeat_existing.catalog_count}`)
  lines.push(`- direct_row_count: ${report.repeat_existing.direct_row_count}`)
  lines.push(`- match_count: ${report.repeat_existing.match_count}`)
  lines.push(`- source_existing_total: ${report.repeat_existing.source_existing_total}`)
  lines.push('', '## Failures')
  if (report.failures.length === 0) lines.push('- none')
  else for (const failure of report.failures) lines.push(`- ${JSON.stringify(failure)}`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const registry = verifyRegistry()
  const forbiddenImports = verifyOwnImports()
  const profileMatrix = await runProfileMatrix()
  const repeatExisting = await verifyExistingRowsStillMatch()

  const failures = [
    ...forbiddenImports.map((pattern) => ({ issue: 'forbidden_verifier_import', pattern })),
    ...registry.issues.map((issue) => ({ scope: 'registry', ...issue })),
    ...profileMatrix.failures,
  ]
  if (!repeatExisting.passed) failures.push({ issue: 'existing_canonical_rows_not_matched', ...repeatExisting })

  const report = {
    generated_at: new Date().toISOString(),
    command,
    engine: 'crawler-os',
    forbidden_imports: forbiddenImports,
    registry,
    profile_matrix: profileMatrix,
    repeat_existing: repeatExisting,
    failures,
  }

  fs.mkdirSync(outDir, { recursive: true })
  for (const name of ['crawler-os-report', 'crawler-system-report']) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(outDir, `${name}.md`), toMarkdown(report))
  }

  console.log(`[crawler-verify] engine=crawler-os sources=${registry.source_count} adapters=${registry.adapter_count}`)
  console.log(`[crawler-verify] profile_runs=${profileMatrix.results.length} repeat_existing=${repeatExisting.passed ? 'PASS' : 'FAIL'}`)
  console.log(`[crawler-verify] failures=${failures.length}`)
  console.log('[crawler-verify] report -> test-results/crawler-os-report.{json,md}')
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[crawler-verify] fatal:', error?.message || error)
  process.exit(2)
})
