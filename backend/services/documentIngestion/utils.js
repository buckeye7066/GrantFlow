import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'

export function nowIso() {
  return new Date().toISOString()
}

export async function sha256File(filePath) {
  const buf = await fsp.readFile(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function countWords(text) {
  const s = String(text || '').trim()
  if (!s) return 0
  return s.split(/\s+/).filter(Boolean).length
}

export function normalizeText(text) {
  if (text == null) return ''
  const withoutNulls = String(text).split('\u0000').join('')
  const s = withoutNulls
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
}

export function isMostlyWhitespace(text) {
  const s = String(text || '')
  if (!s) return true
  const nonWs = s.replace(/\s+/g, '')
  if (!nonWs) return true
  return nonWs.length / Math.max(1, s.length) < 0.05
}

