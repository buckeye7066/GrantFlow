import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const routesRoot = path.join(repoRoot, 'backend', 'routes')

function listJsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJsFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('backend routes use the DB adapter contract instead of db.query()', () => {
  const offenders = []
  for (const file of listJsFiles(routesRoot)) {
    const text = fs.readFileSync(file, 'utf8')
    const routeRel = path.relative(repoRoot, file).replace(/\\/g, '/')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (/\b(?:db|req\.db)\.query\s*\(/.test(line)) {
        offenders.push(`${routeRel}:${index + 1}: ${line.trim()}`)
      }
    })
  }

  assert.deepEqual(
    offenders,
    [],
    `Route files must use db.prepare(...).get/all/run so SQLite and Postgres share one adapter contract:\n${offenders.join('\n')}`,
  )
})
