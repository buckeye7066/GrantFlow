#!/usr/bin/env node
// scripts/fix-mojibake.mjs
//
// The yana → hamilton rename script earlier in this branch read files
// using PowerShell's default code page (cp1252) and wrote them back as
// UTF-8. That double-encoded every multi-byte UTF-8 character so that
// e.g. "�" (em dash, E2 80 94) became the literal three-character
// string "�"" on disk (Win-1252 bytes E2 80 94 re-interpreted as
// Latin-1 + cp1252 high-bytes, then UTF-8 encoded as 6 UTF-8 bytes).
//
// Fix: for every affected file, read the file as UTF-8, then re-encode
// every codepoint through cp1252 (the "wrongly assumed" encoding) to
// recover the original UTF-8 byte sequence, then decode that byte
// sequence as UTF-8.
//
// We only run on files that contain the mojibake marker character
// "�" (U+00E2 U+20AC), which is the unmistakable signature of this
// double-encoding. ASCII files and clean files are skipped.

import fs from 'node:fs/promises'
import path from 'node:path'

// Windows-1252 byte → Unicode codepoint map for bytes 0x80..0x9F (the
// ones that differ from Latin-1). Bytes outside this range round-trip
// the same in cp1252 and Latin-1.
const CP1252_HIGH = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
}
const UNICODE_TO_CP1252 = Object.fromEntries(
  Object.entries(CP1252_HIGH).map(([b, u]) => [u, Number(b)]),
)

function utf8StringToCp1252Bytes(s) {
  const out = Buffer.alloc(s.length * 4)
  let i = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp <= 0x7F) {
      out[i++] = cp
    } else if (cp <= 0xFF && !(cp >= 0x80 && cp <= 0x9F)) {
      // Latin-1 range: same byte in cp1252.
      out[i++] = cp
    } else if (UNICODE_TO_CP1252[cp] !== undefined) {
      out[i++] = UNICODE_TO_CP1252[cp]
    } else {
      // Codepoint not in cp1252 � leave the original UTF-8 untouched.
      const buf = Buffer.from(ch, 'utf8')
      buf.copy(out, i)
      i += buf.length
    }
  }
  return out.slice(0, i)
}

async function fixFile(p) {
  const orig = await fs.readFile(p, 'utf8')
  if (!orig.includes('�') && !orig.includes('� ') && !orig.includes('�\u00A0')
      && !orig.includes('�') && !orig.includes('�')) {
    return false
  }
  const bytes = utf8StringToCp1252Bytes(orig)
  let next
  try {
    next = bytes.toString('utf8')
  } catch {
    return false
  }
  // Sanity check: the fix should EITHER reduce length (3 mojibake
  // chars → 1 original char) or be unchanged. If it grows we've
  // corrupted something.
  if (next.length > orig.length) {
    console.warn(`SKIP ${p}: result longer than original`)
    return false
  }
  if (next === orig) return false
  await fs.writeFile(p, next, 'utf8')
  console.log(`fixed ${p}`)
  return true
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.cache', 'GrantFlow-public-audit'].includes(e.name)) continue
      await walk(full, out)
    } else if (/\.(js|jsx|mjs|cjs|ts|tsx|md|sql|json|sh|ps1)$/i.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

const root = process.cwd()
const files = await walk(root)
let fixed = 0
for (const f of files) {
  try {
    if (await fixFile(f)) fixed += 1
  } catch (err) {
    console.warn(`error ${f}: ${err.message}`)
  }
}
console.log(`Done. ${fixed} files fixed.`)
