import fs from 'node:fs'

const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
const REPLACEMENTS = [
  {
    "path": "scripts/production-deployment-proof.mjs",
    "before": "aW1wb3J0IHByb2Nlc3MgZnJvbSAnbm9kZTpwcm9jZXNzJwoKY29uc3QgV1JJVEVfUkVQT1JU",
    "after": "aW1wb3J0IHByb2Nlc3MgZnJvbSAnbm9kZTpwcm9jZXNzJwoKaW1wb3J0IHsgYnVpbGRSZXBvc2l0b3J5UmVsZWFzZUlkZW50aXR5IH0gZnJvbSAnLi4vc2hhcmVkL3JlbGVhc2VJZGVudGl0eS5qcycKCmNvbnN0IFdSSVRFX1JFUE9SVA==",
    "label": "deployment proof release identity import"
  }
]

function replaceOnce(path, beforeEncoded, afterEncoded, label) {
  const before = decode(beforeEncoded)
  const after = decode(afterEncoded)
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first < 0) throw new Error(path + ': missing expected source for ' + label)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(path + ': expected exactly one source block for ' + label)
  }
  fs.writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length))
}

for (const replacement of REPLACEMENTS) {
  replaceOnce(replacement.path, replacement.before, replacement.after, replacement.label)
}

console.log('Applied proof-first.')
