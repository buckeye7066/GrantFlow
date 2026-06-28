#!/usr/bin/env node
/**
 * Release/deployment status proof.
 *
 * This script intentionally checks only public/status-style signals and never
 * reads secret config. It proves the local branch is clean/pushed (or, with
 * --target-branch, that local HEAD matches that remote branch), current
 * production surfaces are green, and the live backend reports the exact commit
 * being certified.
 * Contract: current production surfaces are green before this proof passes.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const WRITE_REPORT = process.argv.includes('--write')
const REQUIRE_CLEAN = process.argv.includes('--require-clean')
const TARGET_BRANCH = readArgValue('--target-branch', 'branch name')
const PRODUCTION_URL = readArgValue('--production-url', 'URL') || 'https://app.axiombiolabs.org'

function readArgValue(name, label = 'value') {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a ${label}`)
  }
  return value.trim()
}

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

function addAsync(checks, name, label, pass, details = {}) {
  checks.push({ name, command: label, pass: Boolean(pass), details })
}

function firstArrayItem(value) {
  return Array.isArray(value) && value.length ? value[0] : null
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0] ?? ''
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`--production-url must be an http(s) URL; got ${value}`)
  }
  return trimmed
}

function normalizeSha(value) {
  const text = String(value || '').trim()
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : ''
}

function shaMatches(expected, actual) {
  const expectedSha = normalizeSha(expected)
  const actualSha = normalizeSha(actual)
  if (!expectedSha || !actualSha) return false
  return expectedSha === actualSha || expectedSha.startsWith(actualSha) || actualSha.startsWith(expectedSha)
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'grantflow-production-deployment-proof',
    },
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      parse_error: error?.message || String(error),
      body_sample: text.slice(0, 240),
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
  }
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
    branch: firstLine(gitBranch.stdout) || null,
    required: REQUIRE_CLEAN,
  })

  const localHead = run('git', ['rev-parse', 'HEAD'])
  const branchName = run('git', ['branch', '--show-current'])
  const currentBranch = firstLine(branchName.stdout).trim()
  const branchToVerify = TARGET_BRANCH || currentBranch
  const remoteHead = branchToVerify
    ? run('git', ['rev-parse', '--verify', `origin/${branchToVerify}`], { optional: true })
    : { ok: false, stdout: '', stderr: 'no branch selected' }
  add(checks, TARGET_BRANCH ? `local HEAD matches origin/${TARGET_BRANCH}` : 'current branch pushed to origin', remoteHead, localHead.ok && remoteHead.ok && firstLine(localHead.stdout) === firstLine(remoteHead.stdout), {
    branch: currentBranch || null,
    verified_branch: branchToVerify || null,
    local_head: firstLine(localHead.stdout) || null,
    origin_head: firstLine(remoteHead.stdout) || null,
  })
  const expectedHead = firstLine(remoteHead.stdout) || firstLine(localHead.stdout)

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
  add(checks, 'current Vercel production deployment ready', vercel, vercelProductionReady, {
    production_ready_line: vercelText.split(/\r?\n/).find((line) => /\bReady\b.*\bProduction\b/i.test(line)) ?? null,
  })

  const railwayStatus = run('railway', ['service', 'status'])
  const railwayServiceGreen = railwayStatus.ok && /Status:\s+SUCCESS/i.test(railwayStatus.stdout)
  add(checks, 'current Railway service deployment successful', railwayStatus, railwayServiceGreen, {
    status_line: railwayStatus.stdout.split(/\r?\n/).find((line) => /Status:/i.test(line)) ?? null,
  })

  const railwayDeployments = run('railway', ['deployment', 'list'])
  const firstDeploymentLine = railwayDeployments.stdout
    .split(/\r?\n/)
    .find((line) => /^\s*[0-9a-f-]{20,}\s+\|/i.test(line))
  const latestRailwaySuccess = railwayDeployments.ok && /\|\s*SUCCESS\s*\|/i.test(firstDeploymentLine ?? '')
  add(checks, 'current Railway latest deployment successful', railwayDeployments, latestRailwaySuccess, {
    latest_deployment_line: firstDeploymentLine ?? null,
  })

  const productionBaseUrl = normalizeBaseUrl(PRODUCTION_URL)
  const liveVersionUrl = `${productionBaseUrl}/api/version`
  let liveVersion = null
  try {
    liveVersion = await fetchJson(liveVersionUrl)
  } catch (error) {
    liveVersion = { ok: false, status: null, fetch_error: error?.message || String(error) }
  }
  const liveCommit = liveVersion?.data?.commit || liveVersion?.data?.build?.commit_sha || null
  addAsync(checks, 'live backend commit matches certified branch', `GET ${liveVersionUrl}`, liveVersion.ok && shaMatches(expectedHead, liveCommit), {
    expected_head: expectedHead || null,
    live_commit: liveCommit || null,
    branch: liveVersion?.data?.branch || null,
    environment: liveVersion?.data?.environment || null,
    railway: liveVersion?.data?.railway ?? null,
    status: liveVersion?.status ?? null,
    error: liveVersion?.fetch_error || liveVersion?.parse_error || null,
  })

  const failures = checks.filter((check) => !check.pass)
  const report = {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    mode: TARGET_BRANCH
      ? `release-readiness status check; verifies clean local tree/local HEAD matches origin/${TARGET_BRANCH}, current production health, and live backend commit; no secrets read`
      : 'release-readiness status check; verifies clean local tree/current branch pushed, current production health, and live backend commit; no secrets read',
    checks,
    failures,
  }

  console.log('GrantFlow release/deployment status proof')
  console.log(report.mode)
  for (const check of checks) {
    const suffix = check.name === 'local worktree status recorded'
      ? ` (${check.details.clean ? 'clean' : 'dirty; clean not required for this run'})`
      : ''
    console.log(`[${check.pass ? 'ok' : 'FAIL'}] ${check.name}${suffix}`)
  }

  if (WRITE_REPORT) await writeReport(report)
  if (failures.length) {
    console.error('\nRelease/deployment status proof failed:')
    for (const failure of failures) console.error(`- ${failure.name}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
