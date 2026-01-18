#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...(await walk(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(fullPath)
    }
  }
  return files
}

async function main() {
  const root = process.cwd()
  const target = path.join(root, 'tests', 'unit')
  const testFiles = (await walk(target)).sort()

  if (testFiles.length === 0) {
    console.error(`[unit] No test files found under ${target}`)
    process.exitCode = 1
    return
  }

  const child = spawn(process.execPath, ['--test', ...testFiles], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}

main().catch((error) => {
  console.error('[unit] Failed to run unit tests:', error?.message || error)
  process.exitCode = 1
})

