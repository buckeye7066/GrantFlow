#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sarifFiles(inputPath) {
  const resolved = path.resolve(inputPath)
  const stat = fs.statSync(resolved)
  if (stat.isFile()) return [resolved]
  if (!stat.isDirectory()) return []

  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sarif')) files.push(target)
    }
  }
  visit(resolved)
  return files.sort()
}

function ruleCatalog(run = {}) {
  const catalog = new Map()
  const components = [
    run?.tool?.driver,
    ...(Array.isArray(run?.tool?.extensions) ? run.tool.extensions : []),
  ].filter(Boolean)

  for (const component of components) {
    for (const rule of Array.isArray(component?.rules) ? component.rules : []) {
      if (rule?.id) catalog.set(String(rule.id), rule)
    }
  }
  return catalog
}

const FULL_SCAN_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch'])

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

export function assertFullScanSarif(sarifDocuments) {
  if (!Array.isArray(sarifDocuments) || sarifDocuments.length === 0) {
    fail('sarif_missing_runs', 'no SARIF documents were supplied')
  }

  for (const [documentIndex, document] of sarifDocuments.entries()) {
    const runs = Array.isArray(document?.runs) ? document.runs : []
    if (runs.length === 0) {
      fail('sarif_missing_runs', `document ${documentIndex} has no runs`)
    }

    for (const [runIndex, run] of runs.entries()) {
      const incrementalMode = String(run?.properties?.incrementalMode || '').trim()
      const extensionNames = (Array.isArray(run?.tool?.extensions)
        ? run.tool.extensions
        : [])
        .map((extension) => String(extension?.name || '').toLowerCase())

      if (incrementalMode || extensionNames.includes('codeql-action/pr-diff-range')) {
        fail(
          'diff_informed_sarif_not_allowed',
          `document ${documentIndex}, run ${runIndex} is not a full scan`,
        )
      }

      if (
        run?.tool?.driver?.name !== 'CodeQL' ||
        !run?.tool?.driver?.semanticVersion ||
        !Array.isArray(run?.properties?.codeqlConfigSummary?.queries) ||
        run.properties.codeqlConfigSummary.queries.length === 0
      ) {
        fail(
          'full_scan_metadata_missing',
          `document ${documentIndex}, run ${runIndex} lacks CodeQL full-scan metadata`,
        )
      }
    }
  }
}

export function assertFullScanBaselineMetadata(baseline) {
  const source = baseline?.generated_from || {}

  if (baseline?.schema_version !== 2 || source.scan_mode !== 'full') {
    fail(
      'baseline_full_scan_metadata_missing',
      'baseline must use schema 2 and declare generated_from.scan_mode=full',
    )
  }
  if (!FULL_SCAN_EVENTS.has(source.event_name)) {
    fail(
      'baseline_source_event_not_full_scan',
      `unsupported baseline source event: ${source.event_name || 'missing'}`,
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(String(source.commit || ''))) {
    fail('baseline_source_sha_invalid', 'baseline source commit must be a full SHA')
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(source.artifact_digest || ''))) {
    fail('baseline_artifact_digest_invalid', 'baseline SARIF SHA-256 digest is required')
  }
}

export function assertCurrentScanContext(context = {}) {
  if (!FULL_SCAN_EVENTS.has(context.eventName)) {
    fail(
      'current_scan_event_not_full_scan',
      `unsupported current event: ${context.eventName || 'missing'}`,
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(String(context.sha || ''))) {
    fail('current_scan_sha_invalid', 'current scan SHA must be a full SHA')
  }
}

function numericSeverity(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export function countQualifyingFindings(sarifDocuments, policy = {}) {
  const minimum = numericSeverity(policy.minimum_security_severity ?? 7)
  const allowed = new Set(
    (Array.isArray(policy.allowed_precisions) ? policy.allowed_precisions : ['high', 'very-high'])
      .map((value) => String(value).toLowerCase()),
  )
  const counts = new Map()

  for (const document of sarifDocuments) {
    for (const run of Array.isArray(document?.runs) ? document.runs : []) {
      const rules = ruleCatalog(run)
      for (const result of Array.isArray(run?.results) ? run.results : []) {
        const ruleId = String(result?.ruleId || result?.rule?.id || 'unknown')
        const rule = rules.get(ruleId) || {}
        const properties = rule?.properties || {}
        const severity = numericSeverity(properties['security-severity'])
        const precision = String(properties.precision || '').toLowerCase()
        if (severity < minimum || !allowed.has(precision)) continue
        counts.set(ruleId, (counts.get(ruleId) || 0) + 1)
      }
    }
  }

  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export function compareToBaseline(currentCounts, baseline) {
  const allowedCounts = baseline?.counts_by_rule || {}
  const failures = []

  for (const [ruleId, count] of Object.entries(currentCounts || {})) {
    if (!Object.prototype.hasOwnProperty.call(allowedCounts, ruleId)) {
      failures.push({
        rule_id: ruleId,
        current: Number(count) || 0,
        allowed: 0,
        reason: 'new_high_confidence_rule',
      })
      continue
    }
    const allowed = Number(allowedCounts[ruleId]) || 0
    if ((Number(count) || 0) > allowed) {
      failures.push({
        rule_id: ruleId,
        current: Number(count) || 0,
        allowed,
        reason: 'finding_count_increased',
      })
    }
  }

  const currentTotal = Object.values(currentCounts || {}).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  )
  const baselineTotal = Number(baseline?.total) || Object.values(allowedCounts).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  )
  if (currentTotal > baselineTotal) {
    failures.push({
      rule_id: '__total__',
      current: currentTotal,
      allowed: baselineTotal,
      reason: 'total_high_confidence_findings_increased',
    })
  }

  return {
    ok: failures.length === 0,
    current_total: currentTotal,
    baseline_total: baselineTotal,
    current_counts: currentCounts,
    failures,
  }
}

export function evaluateCodeQlBaseline({ sarifPath, baselinePath }) {
  const files = sarifFiles(sarifPath)
  if (files.length === 0) {
    throw new Error(`No SARIF files found at ${sarifPath}`)
  }
  const baseline = readJson(path.resolve(baselinePath))
  const documents = files.map(readJson)
  // Validate the current artifact before the historical baseline so an old PR
  // SARIF reports the precise scan-scope defect even while schema 1 remains.
  assertFullScanSarif(documents)
  assertCurrentScanContext({
    eventName: process.env.CODEQL_SCAN_EVENT,
    repository: process.env.CODEQL_SCAN_REPOSITORY,
    sha: process.env.CODEQL_SCAN_SHA,
  })
  assertFullScanBaselineMetadata(baseline)
  const currentCounts = countQualifyingFindings(documents, baseline.policy)
  return {
    sarif_files: files,
    ...compareToBaseline(currentCounts, baseline),
  }
}

function main(argv = process.argv.slice(2)) {
  const sarifPath = argv[0]
  const baselinePath = argv[1] || '.github/codeql-baseline.json'
  if (!sarifPath) {
    console.error('Usage: node scripts/check-codeql-baseline.mjs <sarif-file-or-directory> [baseline.json]')
    process.exitCode = 2
    return
  }

  try {
    const result = evaluateCodeQlBaseline({ sarifPath, baselinePath })
    console.log('[codeql-baseline] qualifying findings', JSON.stringify({
      current_total: result.current_total,
      baseline_total: result.baseline_total,
      current_counts: result.current_counts,
      sarif_files: result.sarif_files.length,
    }))
    if (!result.ok) {
      for (const failure of result.failures) {
        console.error(
          `[codeql-baseline] BLOCK ${failure.rule_id}: ${failure.current} > ${failure.allowed} (${failure.reason})`,
        )
      }
      process.exitCode = 1
      return
    }
    console.log('[codeql-baseline] PASS: no new high-confidence CodeQL findings')
  } catch (error) {
    console.error('[codeql-baseline] ERROR:', error?.message || String(error))
    process.exitCode = 1
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) main()
