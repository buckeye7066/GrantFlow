import fs from 'node:fs'

const expected = String(process.argv[2] || process.env.EXPECTED_DEPLOYED_COMMIT || '').trim()
if (!/^[a-f0-9]{40}$/i.test(expected)) throw new Error('A 40-character EXPECTED_DEPLOYED_COMMIT is required')

const files = [
  'scripts/vercel-final-audit-challenge.mjs',
  'scripts/vercel-final-authenticated-audit.mjs',
  'api/final-production-audit.js',
]

for (const file of files) {
  let source = fs.readFileSync(file, 'utf8')
  const matches = source.match(/const EXPECTED_SHA = '[a-f0-9]{40}'/gi) || []
  if (matches.length !== 1) throw new Error(`${file}: expected one EXPECTED_SHA assignment, found ${matches.length}`)
  source = source.replace(/const EXPECTED_SHA = '[a-f0-9]{40}'/i, `const EXPECTED_SHA = '${expected}'`)
  fs.writeFileSync(file, source)
}

console.log(`[final-audit-sha] exact production SHA pinned: ${expected}`)
