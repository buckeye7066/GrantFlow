import fs from 'node:fs'

const file = 'tests/unit/deployment-version-contract.test.mjs'
const source = fs.readFileSync(file, 'utf8')
const before = "  assert.match(proof, /Production database migration identity matches release/)"
const after = "  assert.match(proof, /Production database migration ledger matches current release files/)"

if (!source.includes(before)) {
  throw new Error('deployment proof contract expectation was not found')
}
if (source.includes(after)) {
  throw new Error('deployment proof contract expectation is already updated')
}

fs.writeFileSync(file, source.replace(before, after))
console.log(`updated ${file}`)
