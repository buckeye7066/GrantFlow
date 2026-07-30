import fs from 'node:fs'

const data = JSON.parse(fs.readFileSync('audit-dist/challenge.json', 'utf8'))
const values = {
  challenge: String(data.challenge || ''),
  public_key_b64u: String(data.public_key_b64u || ''),
}
for (const [name, value] of Object.entries(values)) {
  if (!value) throw new Error(`${name} missing from challenge output`)
  const size = 700
  const total = Math.ceil(value.length / size)
  for (let index = 0; index < total; index += 1) {
    console.log(`[audit-challenge-chunk] ${name} ${index + 1}/${total} ${value.slice(index * size, (index + 1) * size)}`)
  }
}
console.log(`[audit-challenge-meta] ${JSON.stringify({
  expected_sha: data.expected_sha,
  generated_at: data.generated_at,
  expires_at: data.expires_at,
  email_sent: data.email_sent,
})}`)
