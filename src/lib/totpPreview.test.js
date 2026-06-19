import { describe, it, expect } from "vitest"
import { base32Decode, parseTotpInput, generateTotp, isValidTotpSecret, secondsRemaining } from "./totpPreview"

// RFC 6238 shared secret "12345678901234567890" → base32, with the trailing-6
// codes an authenticator app shows. Must match backend/services/hamilton/hamiltonTotp.js.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

describe("base32Decode", () => {
  it("recovers the RFC seed and tolerates spaces/case/padding", () => {
    expect(new TextDecoder().decode(base32Decode(SEED))).toBe("12345678901234567890")
    expect(new TextDecoder().decode(base32Decode("gezd gnbv-gy3t qojq gezd gnbv-gy3t qojq===")))
      .toBe("12345678901234567890")
  })
  it("throws on invalid characters", () => {
    expect(() => base32Decode("GEZD1NBV")).toThrow()
  })
})

describe("parseTotpInput", () => {
  it("reads an otpauth:// URI", () => {
    const p = parseTotpInput(`otpauth://totp/Portal:u?secret=${SEED}&digits=6&period=30&algorithm=SHA1`)
    expect(p.secret).toBe(SEED)
    expect(p.digits).toBe(6)
    expect(p.period).toBe(30)
    expect(p.hash).toBe("SHA-1")
  })
})

describe("isValidTotpSecret", () => {
  it("accepts good seeds and otpauth URIs, rejects junk", () => {
    expect(isValidTotpSecret(SEED)).toBe(true)
    expect(isValidTotpSecret(`otpauth://totp/x?secret=${SEED}`)).toBe(true)
    expect(isValidTotpSecret("JBSW Y3DP EHPK 3PXP")).toBe(true)
    expect(isValidTotpSecret("not a real key !!!")).toBe(false)
    expect(isValidTotpSecret("")).toBe(false)
  })
})

describe("generateTotp (Web Crypto)", () => {
  it("matches RFC 6238 SHA-1 vectors (trailing 6 digits)", async () => {
    const vectors = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ]
    const codes = await Promise.all(vectors.map(([secs]) => generateTotp(SEED, { now: secs * 1000 })))
    vectors.forEach(([, full8], i) => expect(codes[i]).toBe(full8.slice(-6)))
  })
  it("accepts an otpauth URI and is zero-padded 6 digits", async () => {
    const code = await generateTotp(`otpauth://totp/x?secret=${SEED}`, { now: 0 })
    expect(code).toMatch(/^\d{6}$/)
  })
})

describe("secondsRemaining", () => {
  it("counts down within a 30s window", () => {
    expect(secondsRemaining(0)).toBe(30)
    expect(secondsRemaining(1000)).toBe(29)
    expect(secondsRemaining(29000)).toBe(1)
  })
})
