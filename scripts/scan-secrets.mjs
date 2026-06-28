#!/usr/bin/env node
/**
 * scripts/scan-secrets.mjs
 *
 * Lightweight secret scanner that runs in any CI (including Windows runners
 * without gitleaks installed) and recognises the same patterns gitleaks does
 * for the credentials we actually use. When gitleaks is on PATH it delegates,
 * otherwise it falls back to the built-in regex sweep.
 *
 * Exit 0 = clean; 1 = one or more secrets detected.
 *
 * False-positive management:
 *   - Lines annotated `// scan:allow` / `# scan:allow` are ignored.
 *   - The .gitleaks.toml file is respected when gitleaks is used.
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const ROOT = process.cwd()

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'terminals', 'agent-transcripts', '.next', '.cache', 'docs', '.cursor', '.claude'])
const BIN_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.eot', '.map'])
const IGNORE_FILE_PATTERNS = [/\.test\.(js|mjs|ts|jsx|tsx)$/i, /\.spec\.(js|mjs|ts|jsx|tsx)$/i, /env\.example$/i, /\.md$/i]

// Common placeholder tokens that look like secrets but aren't.
const PLACEHOLDER_RES = [
  /sk-(?:xxx|REPLACE|\.\.\.|<|proj-xxx|proj-REPLACE|proj-\.\.\.|proj-<|ant-your|ant-REPLACE|ant-xxx)/i,
  /AKIA(IOSFODNN7EXAMPLE|EXAMPLE|XXXXX|0000)/,
  /ghp_(?:xxx|REPLACE|example|0{6,})/i,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJ/, // standard JWT header decoded example
  /your[-_](?:openai|anthropic|api|secret|token)[-_]?key/i,
  /placeholder/i,
  /example/i,
]

const PATTERNS = [
  { name: 'OpenAI', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI project', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'AWS Secret Access Key', re: /aws_secret_access_key\s*=\s*['\"]?[A-Za-z0-9/+=]{40}['\"]?/gi },
  { name: 'GitHub PAT', re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe live key', re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { name: 'JWT (three-dot token)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |)PRIVATE KEY-----/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Twilio API key', re: /\bSK[a-f0-9]{32}\b/g },
]

const findings = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (BIN_EXTS.has(ext)) continue
      if (/\.lock$/.test(entry.name)) continue
      if (IGNORE_FILE_PATTERNS.some((re) => re.test(entry.name))) continue
      scan(full)
    }
  }
}

function listGitVisibleFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'buffer',
  })
  if (result.error || result.status !== 0) return null
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((file) => path.join(ROOT, file))
}

function shouldScanFile(file) {
  const name = path.basename(file)
  const ext = path.extname(name).toLowerCase()
  if (BIN_EXTS.has(ext)) return false
  if (/\.lock$/.test(name)) return false
  if (IGNORE_FILE_PATTERNS.some((re) => re.test(name))) return false
  return true
}

function scan(file) {
  if (!shouldScanFile(file)) return
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (text.length > 5 * 1024 * 1024) return // skip files >5MB
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/scan:allow/i.test(line)) continue
    if (PLACEHOLDER_RES.some((re) => re.test(line))) continue
    for (const p of PATTERNS) {
      p.re.lastIndex = 0
      if (p.re.test(line)) {
        const rel = path.relative(ROOT, file)
        findings.push({ file: rel, line: i + 1, type: p.name, sample: line.trim().slice(0, 160) })
      }
    }
  }
}

function tryGitleaks() {
  const r = spawnSync('gitleaks', ['detect', '--no-git', '--redact', '--config=.gitleaks.toml'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (r.error) return null
  return r.status ?? 0
}

const gitleaksCode = tryGitleaks()
if (gitleaksCode !== null) {
  process.exit(gitleaksCode)
}

// Fallback regex sweep.
const gitVisibleFiles = listGitVisibleFiles()
if (gitVisibleFiles) {
  for (const file of gitVisibleFiles) scan(file)
} else {
  walk(ROOT)
}

if (findings.length === 0) {
  console.log('[scan-secrets] OK (0 findings)')
  process.exit(0)
}

console.error(`[scan-secrets] FAIL (${findings.length} findings)`)
for (const f of findings.slice(0, 100)) {
  console.error(`  ${f.file}:${f.line}  [${f.type}]  ${f.sample}`)
}
if (findings.length > 100) console.error(`  ... and ${findings.length - 100} more`)
console.error('')
console.error('  Remediation:')
console.error('    1. Move the literal into process.env and load via backend/config/env.js')
console.error('    2. Rotate the exposed secret out-of-band (see SECURITY.md)')
console.error("    3. If genuinely not a secret, annotate the line with `// scan:allow`")
process.exit(1)
