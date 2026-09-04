import fs from 'node:fs'

const path = 'backend/utils/grantFingerprint.js'
const before = fs.readFileSync(path, 'utf8')
const oldText = 'function opportunityFunder(opportunity = {}) {'
const newText = 'export function opportunityFunder(opportunity = {}) {'
const count = before.split(oldText).length - 1
if (count !== 1) {
  throw new Error(`expected one private opportunityFunder declaration, found ${count}`)
}
fs.writeFileSync(path, before.replace(oldText, newText), 'utf8')
