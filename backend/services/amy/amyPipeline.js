/**
 * amyPipeline.js
 *
 * The Amy → Anya → Sam handoff. After Amy measures crawler weaknesses, this:
 *
 *   1. ANYA — runs the autonomous code crawl on the REAL files implicated by
 *      Amy's findings (root-cause + optional safe code-quality fixes).
 *   2. SAM — runs Sam's safe-fix pass (eslint/readiness) so applied edits are
 *      verified and saved, and Sam's diagnostics confirm the repo is healthy.
 *
 * Both legs are dependency-injected (so tests run offline) and wrapped so a
 * failure in the chain never breaks the Amy run. Whether Anya/Sam actually
 * WRITE is governed by `apply` flags — analysis is always safe to run.
 */

import path from 'node:path'
import { createLogger } from '../../utils/logger.js'

const defaultLog = createLogger('services:amy:pipeline')

/** Lazy default importers so tests can inject fakes without loading heavy deps. */
async function defaultRunAnya(args, ctx) {
  const { runAutonomousCodeCrawl } = await import('../anyaAutonomousCrawler.js')
  return runAutonomousCodeCrawl(args, ctx)
}
async function defaultRunSam(args) {
  const { runSam } = await import('../sam/samAgent.js')
  return runSam(args)
}

/**
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.amyResult        - output of runAmyTraining (has .report.findings)
 * @param {object} [args.options]
 * @param {boolean} [args.options.anyaEnabled=true]
 * @param {boolean} [args.options.anyaApply=false]  - Anya writes code fixes
 * @param {boolean} [args.options.samEnabled=true]
 * @param {boolean} [args.options.samApply=false]   - Sam applies+saves safe fixes
 * @param {number}  [args.options.maxFiles=12]      - cap Anya scans per run
 * @param {Function} [args.runAnya]  - inject for tests
 * @param {Function} [args.runSam]   - inject for tests
 * @param {object}  [args.logger]
 * @returns {Promise<object>} chain result (never throws)
 */
export async function runAmyAnyaSamPipeline({
  db,
  amyResult,
  options = {},
  runAnya = defaultRunAnya,
  runSam = defaultRunSam,
  logger = defaultLog,
} = {}) {
  const {
    anyaEnabled = true,
    anyaApply = false,
    samEnabled = true,
    samApply = false,
    maxFiles = 12,
  } = options

  const findings = amyResult?.report?.findings || []
  const targetFiles = [...new Set(findings.map((f) => f?.file).filter(Boolean))].slice(0, maxFiles)

  const chain = {
    anya: { enabled: anyaEnabled, applied: anyaApply, files_targeted: targetFiles, reports: [], files_modified: 0, findings_total: 0, error: null },
    sam: { enabled: samEnabled, applied: samApply, run_id: null, health_score: null, applied_fixes: [], findings_total: 0, error: null },
  }

  // ── Anya: root-cause analysis on the implicated files ──────────────────
  if (anyaEnabled && targetFiles.length > 0) {
    for (const rel of targetFiles) {
      try {
        const report = await runAnya(
          {
            directory: path.dirname(rel),
            pattern: path.basename(rel),
            dryRun: !anyaApply,
            includeDomainAudits: false,
            maxIterations: 50,
            maxFileChanges: anyaApply ? 3 : 0,
            fixEmptyCatch: true,
          },
          { db, userId: 'agent:amy' },
        )
        chain.anya.reports.push({
          file: rel,
          findings_found: report?.findings_found ?? (report?.findings?.length ?? 0),
          files_modified: report?.files_modified ?? (report?.modifications?.length ?? 0),
          top_findings: Array.isArray(report?.findings) ? report.findings.slice(0, 5) : [],
          modifications: Array.isArray(report?.modifications)
            ? report.modifications.map((m) => ({ file: m.file, changes_count: m.changes_count, dry_run: m.dry_run, diff_preview: m.diff_preview }))
            : [],
        })
        chain.anya.findings_total += report?.findings_found ?? (report?.findings?.length ?? 0)
        chain.anya.files_modified += report?.files_modified ?? (report?.modifications?.length ?? 0)
      } catch (err) {
        logger.warn?.('amy.pipeline.anya.error', { file: rel, error: err?.message })
        chain.anya.reports.push({ file: rel, error: String(err?.message || err) })
      }
    }
  }

  // ── Sam: verified safe-fix pass + health diagnostics ───────────────────
  if (samEnabled) {
    try {
      const { SAM_MODES } = await import('../sam/samTypes.js')
      const samResult = await runSam({
        db,
        ctx: { isAdmin: true, samAuthorised: true, userId: 'agent:amy' },
        mode: samApply ? SAM_MODES.REPAIR_SAFE : SAM_MODES.OBSERVE,
        dryRun: !samApply,
        fixIds: [],
        trigger: 'amy_pipeline',
        persist: true,
      })
      chain.sam.run_id = samResult?.run_id ?? null
      chain.sam.health_score = samResult?.health_score ?? samResult?.summary?.health_score ?? null
      chain.sam.applied_fixes = Array.isArray(samResult?.applied_fixes) ? samResult.applied_fixes : []
      chain.sam.findings_total = Array.isArray(samResult?.findings) ? samResult.findings.length : 0
    } catch (err) {
      logger.warn?.('amy.pipeline.sam.error', { error: err?.message })
      chain.sam.error = String(err?.message || err)
    }
  }

  logger.info?.('amy.pipeline.complete', {
    anya_files: targetFiles.length,
    anya_modified: chain.anya.files_modified,
    sam_run: chain.sam.run_id,
    sam_fixes: chain.sam.applied_fixes.length,
  })

  return chain
}

export default { runAmyAnyaSamPipeline }
