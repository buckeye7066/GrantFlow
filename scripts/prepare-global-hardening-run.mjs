import fs from 'node:fs'

function replaceExact(file, before, after, label) {
  const text = fs.readFileSync(file, 'utf8')
  const first = text.indexOf(before)
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block missing or ambiguous`)
  }
  fs.writeFileSync(file, text.slice(0, first) + after + text.slice(first + before.length))
}

replaceExact(
  'scripts/apply-code-hardening.mjs',
  `replaceOne(
  'backend/crawler-os/tests/fetcher.test.mjs',
  /\\['203\\.0\\.113\\.10'\\]/g,
  "['8.8.8.8']",
  'fetcher public fixture',
)`,
  `{ // Two public-address fixtures intentionally share the same test resolver.
  const file = 'backend/crawler-os/tests/fetcher.test.mjs'
  const before = read(file)
  const matches = before.match(/\\['203\\.0\\.113\\.10'\\]/g) || []
  if (matches.length !== 2) {
    throw new Error(\`fetcher public fixture: expected two matches, found \${matches.length}\`)
  }
  write(file, before.replaceAll("['203.0.113.10']", "['8.8.8.8']"))
}`,
  'fetcher fixture transformation',
)

const readiness = 'scripts/apply-readiness-deployment.mjs'
const readinessText = fs.readFileSync(readiness, 'utf8')
const updated = readinessText.replaceAll(
  'npm ci --include=optional',
  'npm ci --include=dev --include=optional',
)
if (updated === readinessText) {
  throw new Error('readiness install command transformation found no source')
}
fs.writeFileSync(readiness, updated)

console.log('[global-hardening] preparation complete')
