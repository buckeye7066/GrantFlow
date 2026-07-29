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
