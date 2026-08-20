#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const REPO_ROOT = path.resolve(process.cwd())

const DEFAULT_TARGET_DIRS = [
  'backend/services',
  'backend/routes',
  'backend/middleware',
  'backend/utils',
  'backend/config',
]

function parseArgs(argv) {
  const args = new Set(argv.slice(2))
  return {
    report: args.has('--report'),
    target: (() => {
      const idx = argv.indexOf('--path')
      if (idx === -1) return null
      return argv[idx + 1] || null
    })(),
  }
}

async function readAllowlist() {
  const filePath = path.join(REPO_ROOT, 'codeQualityGate.allowlist.json')
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const json = JSON.parse(raw)
    return {
      allowed_console_files: new Set(json.allowed_console_files || []),
      allowed_todo_files: new Set(json.allowed_todo_files || []),
      allowed_empty_catch_files: new Set(json.allowed_empty_catch_files || []),
      allowed_unhandled_then_files: new Set(json.allowed_unhandled_then_files || []),
    }
  } catch {
    return {
      allowed_console_files: new Set(),
      allowed_todo_files: new Set(),
      allowed_empty_catch_files: new Set(),
      allowed_unhandled_then_files: new Set(),
    }
  }
}

async function listFilesRecursive(absDir) {
  const out = []
  const entries = await fs.readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      out.push(...(await listFilesRecursive(full)))
    } else if (entry.isFile()) {
      if (!/\.(mjs|cjs|js|ts|tsx|jsx)$/.test(entry.name)) continue
      out.push(full)
    }
  }
  return out
}

function rel(p) {
  return path.relative(REPO_ROOT, p).replaceAll('\\', '/')
}

function isEmptyCatch(trimmed) {
  return (
    trimmed === 'catch (error) {}' ||
    trimmed === 'catch {}' ||
    trimmed === 'catch (e) {}' ||
    trimmed === 'catch (err) {}'
  )
}

function isTodoMarker(line) {
  return /\/\/\s*(TODO|FIXME|XXX|HACK)\b/i.test(line)
}

function isConsoleOffender(line) {
  return line.includes('console.log(') || line.includes('console.error(')
}

function isUnhandledThenHeuristic(lines, idx) {
  const line = lines[idx] || ''
  if (!line.includes('.then(')) return false
  if (line.includes('// code-quality-gate: allow-unhandled')) return false

  // Allow same-line catch.
  if (line.includes('.catch(')) return false

  // Allow multi-line chaining where a .catch appears shortly after.
  for (let i = idx + 1; i < Math.min(lines.length, idx + 80); i += 1) {
    const next = lines[i] || ''
    if (next.includes('.catch(')) return false
  }

  // If the line is awaited, treat it as handled by surrounding try/catch.
  if (line.includes('await ')) return false

  return true
}

async function scanFile(filePath, allowlist) {
  const relative = rel(filePath)
  const text = await fs.readFile(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const violations = []

  const allowConsole = allowlist.allowed_console_files.has(relative)
  const allowTodo = allowlist.allowed_todo_files.has(relative)
  const allowEmptyCatch = allowlist.allowed_empty_catch_files.has(relative)
  const allowUnhandledThen = allowlist.allowed_unhandled_then_files.has(relative)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    const lineNo = i + 1

    if (!allowEmptyCatch && isEmptyCatch(trimmed)) {
      violations.push({ rule: 'empty_catch', file: relative, line: lineNo, text: trimmed })
    }

    if (!allowTodo && isTodoMarker(line)) {
      violations.push({ rule: 'task_marker', file: relative, line: lineNo, text: trimmed })
    }

    if (!allowConsole && isConsoleOffender(line)) {
      violations.push({ rule: 'console_usage', file: relative, line: lineNo, text: trimmed })
    }

    if (!allowUnhandledThen && isUnhandledThenHeuristic(lines, i)) {
      violations.push({ rule: 'unhandled_then', file: relative, line: lineNo, text: trimmed })
    }
  }

  return violations
}

/**
 * Run ESLint check and return { success, errorCount, warningCount }
 */
async function runEslintCheck() {
  return new Promise((resolve) => {
    // Windows: `npx`/`.cmd` resolution requires shell:true so PATHEXT and
    // .cmd shims are honored. POSIX runners are unaffected.
    const useShell = process.platform === 'win32'
    // `--no-install` is LOAD-BEARING. A bare `npx eslint` falls back to
    // DOWNLOADING whatever version npm considers latest when local resolution
    // misses -- measured here fetching eslint@10.8.1 against this repo's
    // pinned ^9.39.1. A gate that silently runs a different MAJOR version of
    // the linter is not checking this repo's rules, and a network hiccup then
    // reads as a code failure. With --no-install a missing eslint fails loudly
    // as a setup error instead of quietly becoming a different check.
    const child = spawn('npx', ['--no-install', 'eslint', '--ext', '.js,.jsx,.mjs,.cjs', 'src', 'backend'], {
      cwd: REPO_ROOT,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    let stdout = ''
    let stderr = ''
    
    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    
    let settled = false
    child.on('error', (err) => {
      if (settled) return
      settled = true
      resolve({ success: false, output: `spawn error: ${err.message}`, exitCode: 1 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({
        success: code === 0,
        output: stdout + stderr,
        exitCode: code ?? 1,
      })
    })
  })
}

function formatViolation(v) {
  return `${v.file}:${v.line} [${v.rule}] ${v.text}`
}

async function main() {
  const { report, target } = parseArgs(process.argv)
  const allowlist = await readAllowlist()

  // Step 1: Run ESLint check first (only when scanning default dirs, not a custom --path)
  if (!target) {
    console.log('[quality-gate] Running ESLint check...')
    const eslintResult = await runEslintCheck()

    if (!eslintResult.success) {
      console.log('[quality-gate] ESLint FAILED:\n')
      console.log(eslintResult.output)
      console.log('\n[quality-gate] FAILED: ESLint found errors. Fix these before proceeding.')
      console.log('[quality-gate] Tip: Run "npx eslint --fix ..." to auto-fix some issues.')
      process.exitCode = 1
      return
    }
    console.log('[quality-gate] ESLint passed ✓')
  }

  // Step 2: Run pattern-based quality checks
  const targetDirs = target
    ? [target]
    : DEFAULT_TARGET_DIRS

  const files = []
  for (const dir of targetDirs) {
    const abs = path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir)
    try {
      // eslint-disable-next-line no-await-in-loop
      files.push(...(await listFilesRecursive(abs)))
    } catch {
      // ignore missing dirs
    }
  }

  const allViolations = []
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const v = await scanFile(f, allowlist)
    allViolations.push(...v)
  }

  if (allViolations.length === 0) {
    console.log('[quality-gate] OK: no blocking code-quality violations found')
    return
  }

  const grouped = allViolations.reduce((acc, v) => {
    acc[v.rule] = acc[v.rule] || []
    acc[v.rule].push(v)
    return acc
  }, {})

  console.log('[quality-gate] Violations found:')
  for (const [rule, items] of Object.entries(grouped)) {
    console.log(`\n- ${rule}: ${items.length}`)
    for (const v of items.slice(0, report ? items.length : Math.min(items.length, 200))) {
      console.log(`  ${formatViolation(v)}`)
    }
    if (!report && items.length > 200) {
      console.log('  ... truncated (use --report to show all)')
    }
  }

  process.exitCode = 1
}

main().catch((err) => {
  console.error('[quality-gate] FAILED:', err?.message || err)
  process.exit(1)
})

