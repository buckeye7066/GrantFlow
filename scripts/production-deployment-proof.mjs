#!/usr/bin/env node
/**
 * Live deployment proof.
 *
 * This script intentionally checks only public/status-style signals and never
 * reads environment variables or secret config. It proves the current GitHub,
 * Vercel, and Railway surfaces are reachable and green for release readiness.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const WRITE_REPORT = process.argv.includes('--write')
const REQUIRE_CLEAN = process.argv.includes('--require-clean')

function run(cmd, args, { json = false, optional = false } = {}) {
  const invocation = buildInvocation(cmd, args)
  const result = spawnSync(invocation.cmd, invocation.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: 1024 * 1024 * 8,
  })
  const stdout = String(result.stdout || '').trim()
  const stderr = String(result.stderr || '').trim()
  const ok = result.status === 0
  const out = {
    cmd: `${cmd} ${args.join(' ')}`,
    ok,
    status: result.status,
    stdout,
    stderr: stderr ? redact(stderr) : '',
  }
  if (!ok && !optional) return out
  if (json && stdout) {
    try {
      out.data = JSON.parse(stdout)
    } catch (error) {
      out.ok = false
      out.parse_error = error?.message || 'json parse failed'
    }
  }
  return out
}

function buildInvocation(cmd, args) {
  if (process.platform !== 'win32') return { cmd, args }
  const commandLine = [cmd, ...args].map(quoteCmdArg).join(' ')
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
}

function quoteCmdArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=,@-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function redact(value) {
  return String(value)
    .replace(/(token|secret|password|key)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
}

function add(checks, name, command, pass, details = {}) {
  checks.push({ name, command: command?.cmd ?? null, pass: Boolean(pass), details })
}

function firstArrayItem(value) {
  return Array.isArray(value) && value.length ? value[0] : null
}

async function writeReport(report) {
  const outDir = path.resolve('docs/_readiness_logs')
  await mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, 'production-deployment-proof.json')
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`)
}

async function main() {
  const checks = []

  const gitBranch = run('git', ['status', '--short', '--branch'])
  const gitClean = gitBranch.ok && !gitBranch.stdout.split(/\r?\n/).slice(1).some(Boolean)
  add(checks, REQUIRE_CLEAN ? 'local worktree clean' : 'local worktree status recorded', gitBranch, gitBranch.ok && (!REQUIRE_CLEAN || gitClean), {
    clean: gitClean,
    branch: gitBranch.stdout.split(/\r?\n/)[0] ?? null,
    required: REQUIRE_CLEAN,
  })

  const openPrs = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url'], { json: true })
  add(checks, 'GitHub open PRs resolved', openPrs, openPrs.ok && Array.isArray(openPrs.data) && openPrs.data.length === 0, {
    open_prs: Array.isArray(openPrs.data) ? openPrs.data : null,
  })

  const latestCi = run('gh', [
    'run',
    'list',
    '--branch',
    'main',
    '--workflow',
    'CI',
    '--limit',
    '1',
    '--json',
    'databaseId,status,conclusion,headSha,createdAt,url,displayTitle',
  ], { json: true })
  const ci = firstArrayItem(latestCi.data)
  add(checks, 'GitHub latest main CI green', latestCi, latestCi.ok && ci?.status === 'completed' && ci?.conclusion === 'success', {
    status: ci?.status ?? null,
    conclusion: ci?.conclusion ?? null,
    head_sha: ci?.headSha ?? null,
    run_url: ci?.url ?? null,
    created_at: ci?.createdAt ?? null,
    title: ci?.displayTitle ?? null,
  })

  const vercel = run('vercel', ['ls', '--yes'])
  const vercelText = `${vercel.stdout}\n${vercel.stderr}`
  const vercelProductionReady = vercel.ok && /\bReady\b.*\bProduction\b/i.test(vercelText)
  add(checks, 'Vercel production deployment ready', vercel, vercelProductionReady, {
    production_ready_line: vercelText.split(/\r?\n/).find((line) => /\bReady\b.*\bProduction\b/i.test(line)) ?? null,
  })

  const railwayStatus = run('railway', ['service', 'status'])
  const railwayServiceGreen = railwayStatus.ok && /Status:\s+SUCCESS/i.test(railwayStatus.stdout)
  add(checks, 'Railway service deployment successful', railwayStatus, railwayServiceGreen, {
    status_line: railwayStatus.stdout.split(/\r?\n/).find((line) => /Status:/i.test(line)) ?? null,
  })

  const railwayDeployments = run('railway', ['deployment', 'list'])
  const firstDeploymentLine = railwayDeployments.stdout
    .split(/\r?\n/)
    .find((line) => /^\s*[0-9a-f-]{20,}\s+\|/i.test(line))
  const latestRailwaySuccess = railwayDeployments.ok && /\|\s*SUCCESS\s*\|/i.test(firstDeploymentLine ?? '')
  add(checks, 'Railway latest deployment successful', railwayDeployments, latestRailwaySuccess, {
    latest_deployment_line: firstDeploymentLine ?? null,
  })

  const failures = checks.filter((check) => !check.pass)
  const report = {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    mode: 'live status check; no env vars or secrets read',
    checks,
    failures,
  }

  console.log('GrantFlow live deployment proof')
  console.log(report.mode)
  for (const check of checks) {
    const suffix = check.name === 'local worktree status recorded'
      ? ` (${check.details.clean ? 'clean' : 'dirty; clean not required for this run'})`
      : ''
    console.log(`[${check.pass ? 'ok' : 'FAIL'}] ${check.name}${suffix}`)
  }

  if (WRITE_REPORT) await writeReport(report)
  if (failures.length) {
    console.error('\nLive deployment proof failed:')
    for (const failure of failures) console.error(`- ${failure.name}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
