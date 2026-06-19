import test from 'node:test'
import assert from 'node:assert/strict'

import { generateTotp, base32Decode, parseTotpInput, isValidTotpSecret } from '../../backend/services/hamilton/hamiltonTotp.js'

// RFC 6238 Appendix B test vectors. The shared secret is the ASCII string
// "12345678901234567890" (20 bytes), which is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
// in base32. The RFC prints 8-digit codes; an authenticator app shows the
// trailing 6, which is what we generate by default.
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('base32Decode recovers the RFC 6238 ASCII seed', () => {
  assert.equal(base32Decode(SECRET_B32).toString('ascii'), '12345678901234567890')
})

test('base32Decode tolerates lowercase, spaces, hyphens, and padding', () => {
  const messy = 'gezd gnbv-gy3t qojq gezd gnbv-gy3t qojq==='
  assert.equal(base32Decode(messy).toString('ascii'), '12345678901234567890')
})

test('base32Decode rejects invalid characters', () => {
  assert.throws(() => base32Decode('GEZD1NBV'), /invalid base32/)
})

test('generateTotp matches RFC 6238 SHA-1 vectors (trailing 6 digits)', () => {
  // [unix time seconds, full 8-digit RFC code] → expect trailing 6.
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ]
  for (const [secs, full8] of vectors) {
    const code = generateTotp(SECRET_B32, { now: secs * 1000 })
    assert.equal(code, full8.slice(-6), `t=${secs}`)
  }
})

test('generateTotp is stable within a 30s window and rotates across it', () => {
  const a = generateTotp(SECRET_B32, { now: 60_000 })       // counter 2
  const b = generateTotp(SECRET_B32, { now: 89_000 })       // still counter 2
  const c = generateTotp(SECRET_B32, { now: 90_000 })       // counter 3
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('generateTotp always returns a zero-padded 6-digit string', () => {
  for (const secs of [0, 30, 12345, 987654]) {
    const code = generateTotp(SECRET_B32, { now: secs * 1000 })
    assert.match(code, /^\d{6}$/)
  }
})

test('parseTotpInput extracts secret and params from an otpauth URI', () => {
  const uri = `otpauth://totp/Portal:user@example.com?secret=${SECRET_B32}&issuer=Portal&digits=6&period=30&algorithm=SHA1`
  const parsed = parseTotpInput(uri)
  assert.equal(parsed.secret, SECRET_B32)
  assert.equal(parsed.digits, 6)
  assert.equal(parsed.period, 30)
  assert.equal(parsed.algorithm, 'sha1')
})

test('generateTotp accepts an otpauth URI and matches the raw-seed code', () => {
  const uri = `otpauth://totp/Portal:u?secret=${SECRET_B32}`
  assert.equal(
    generateTotp(uri, { now: 59_000 }),
    generateTotp(SECRET_B32, { now: 59_000 }),
  )
})

test('isValidTotpSecret flags good vs malformed seeds', () => {
  assert.equal(isValidTotpSecret(SECRET_B32), true)
  assert.equal(isValidTotpSecret(`otpauth://totp/x?secret=${SECRET_B32}`), true)
  assert.equal(isValidTotpSecret('not valid !!!'), false)
  assert.equal(isValidTotpSecret(''), false)
  assert.equal(isValidTotpSecret(null), false)
})
