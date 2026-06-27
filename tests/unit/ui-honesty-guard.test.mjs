import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const UI_DIRS = [
  path.join(ROOT, 'src', 'components'),
  path.join(ROOT, 'src', 'pages'),
]

const FILE_RE = /\.(jsx|js)$/
const TEST_FILE_RE = /\.(test|spec)\.(jsx|js)$/

const FORBIDDEN_TEXT = [
  {
    label: 'user-facing coming soon promise',
    pattern: /\bcoming soon\b/i,
  },
  {
    label: 'placeholder workflow copy',
    pattern: /placeholder for|report generation coming soon|replace with real|simulate by fetching/i,
  },
  {
    label: 'fake queued workflow copy',
    pattern: /command queued|workflow dispatched|background job queued without backend|fake automation/i,
  },
]

const NAVIGATE_ACTION_WITH_WORK_VERB =
  /type:\s*["']navigate["'][\s\S]{0,140}?label:\s*["'](?:Run|Generate|Process|Add)\b/i

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(full))
    } else if (entry.isFile() && FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

test('user-facing workflow UI does not promise fake or unfinished actions', async () => {
  const files = (await Promise.all(UI_DIRS.map(walk))).flat()
  const findings = []

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const rel = path.relative(ROOT, file)

    for (const rule of FORBIDDEN_TEXT) {
      if (rule.pattern.test(text)) {
        findings.push(`${rel}: ${rule.label}`)
      }
    }

    if (NAVIGATE_ACTION_WITH_WORK_VERB.test(text)) {
      findings.push(`${rel}: navigation action label uses a work verb; say "Open ..." or invoke a real tool instead`)
    }
  }

  assert.deepEqual(findings, [])
})
