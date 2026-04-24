#!/usr/bin/env node
/**
 * Anya autonomous crawler CLI harness.
 *
 * By default this runs as a dry run — no files are modified. Two gates
 * must BOTH be lit to enable writes:
 *
 *   1. Env: ANYA_AUTONOMOUS_WRITES=1   (operator-level opt-in on the host)
 *   2. CLI: --write                    (explicit intent on this invocation)
 *
 * If either is missing, the crawler will report `dry_run_effective=true`
 * and `dry_run_forced_by_env=true` with no file modifications. This is
 * intentional — it prevents accidental or remote-triggered writes.
 *
 * Usage:
 *   node scripts/anya-autonomous.mjs                      # dry run (safe)
 *   ANYA_AUTONOMOUS_WRITES=1 node scripts/anya-autonomous.mjs --write
 *   node scripts/anya-autonomous.mjs --directory backend --pattern '*.js'
 *   node scripts/anya-autonomous.mjs --fix-empty-catch --fix-console-log --write
 *
 * Flags:
 *   --write                      Arm the per-invocation write gate
 *   --directory <path>           Restrict crawl to a directory (default: repo root)
 *   --pattern <glob>             Restrict to files matching the glob
 *   --max-iterations <n>         Default 50
 *   --max-file-changes <n>       Default 20
 *   --fix-console-log            Rewrite debug console.log → logger.debug
 *   --fix-empty-catch            Fill empty catch blocks with a tracked log
 *   --fix-todos                  Convert task-marker comments to tracked issues
 *   --no-domain-audits           Skip domain audits
 *   --help                       Show this help
 */

/* eslint-disable no-console */

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      args.help = true
      continue
    }
    if (a === '--write') { args.write = true; continue }
    if (a === '--fix-console-log') { args.fixConsoleLog = true; continue }
    if (a === '--fix-empty-catch') { args.fixEmptyCatch = true; continue }
    if (a === '--fix-todos') { args.fixTodos = true; continue }
    if (a === '--no-domain-audits') { args.includeDomainAudits = false; continue }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[toCamel(key)] = next
        i++
      } else {
        args[toCamel(key)] = true
      }
      continue
    }
    args._.push(a)
  }
  return args
}

function toCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase())
}

function showHelp() {
  const banner = [
    '',
    'Anya autonomous crawler',
    '=======================',
    'Safe by default. Writes require BOTH ANYA_AUTONOMOUS_WRITES=1 and --write.',
    '',
  ].join('\n')
  console.log(banner)
  const header = '/**\n'
  // Extract the JSDoc-style header at the top of this file and print it.
  // Keep it simple: just point the user at --help in source comments.
  console.log('See the comment header at the top of scripts/anya-autonomous.mjs for full flag reference.')
  console.log(header ? '' : '')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    showHelp()
    return
  }

  const envValue = process.env.ANYA_AUTONOMOUS_WRITES ?? process.env.ANYA_AUTONOMOUS_WRITE_CHANGES ?? ''
  const writesEnv = /^(1|true|yes|on)$/i.test(String(envValue).trim())
  const writeFlag = Boolean(args.write)
  const dryRunRequested = !writeFlag

  if (writeFlag && !writesEnv) {
    console.error(
      '[anya-autonomous] --write was requested, but ANYA_AUTONOMOUS_WRITES is not set.\n' +
        'Crawler will run as DRY RUN. Set ANYA_AUTONOMOUS_WRITES=1 on the host to arm writes.'
    )
  }
  if (writesEnv && !writeFlag) {
    console.log(
      '[anya-autonomous] ANYA_AUTONOMOUS_WRITES is enabled on the host, but --write was NOT passed.\n' +
        'Crawler will run as DRY RUN. Pass --write to enable file modifications.'
    )
  }

  const { runAutonomousCodeCrawl } = await import('../backend/services/anyaAutonomousCrawler.js')

  const options = {
    directory: args.directory ?? '',
    pattern: args.pattern ?? null,
    maxIterations: args.maxIterations ? Number(args.maxIterations) : 50,
    maxFileChanges: args.maxFileChanges ? Number(args.maxFileChanges) : 20,
    dryRun: dryRunRequested,
    writeFlag,
    fixConsoleLog: Boolean(args.fixConsoleLog),
    fixEmptyCatch: Boolean(args.fixEmptyCatch),
    fixTodos: Boolean(args.fixTodos),
    includeDomainAudits: args.includeDomainAudits !== false,
  }

  const context = { db: null, userId: 'cli', cli: true }
  const report = await runAutonomousCodeCrawl(options, context)

  const summary = {
    dry_run_effective: report.dry_run_effective,
    dry_run_forced_by_env: report.dry_run_forced_by_env,
    writes_env_enabled: report.writes_env_enabled,
    write_flag_enabled: report.write_flag_enabled,
    files_scanned: report.files_scanned,
    findings_total: report.findings_total,
    files_modified: report.files_modified,
    issues_fixed: report.issues_fixed,
    duration_ms: report.duration_ms,
    errors: Array.isArray(report.errors) ? report.errors.length : 0,
  }
  console.log(JSON.stringify(summary, null, 2))

  if (Array.isArray(report.errors) && report.errors.length > 0) {
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error('[anya-autonomous] fatal:', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
