#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const backendRoot = path.join(repoRoot, 'backend')
const routeMethods = ['get', 'post', 'put', 'patch', 'delete', 'all']

async function collectJsFiles(dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectJsFiles(full))
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function findViolations(file, source) {
  const violations = []
  const lines = source.split(/\r?\n/)
  lines.forEach((line, idx) => {
    const checks = [
      /\b(?:router|app)\.use\s*\(\s*requireAuthenticatedUser(?!Middleware)\b/,
      /\b(?:router|app)\.use\s*\([^)]*,\s*requireAuthenticatedUser(?!Middleware)\b/,
      new RegExp(`\\b(?:router|app)\\.(?:${routeMethods.join('|')})\\s*\\([^\\n]*,\\s*requireAuthenticatedUser(?!Middleware)\\b`),
    ]
    if (checks.some((rx) => rx.test(line))) {
      violations.push({
        file: path.relative(repoRoot, file).replace(/\\/g, '/'),
        line: idx + 1,
        text: line.trim(),
      })
    }
  })
  return violations
}

const files = await collectJsFiles(backendRoot)
const violations = []
for (const file of files) {
  const source = await fs.readFile(file, 'utf8')
  violations.push(...findViolations(file, source))
}

if (violations.length > 0) {
  console.error('requireAuthenticatedUser is a guard helper, not Express middleware.')
  console.error('Use requireAuthenticatedUserMiddleware at router/app mount points instead.\n')
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.text}`)
  }
  process.exit(1)
}

console.log('Auth middleware check passed.')
