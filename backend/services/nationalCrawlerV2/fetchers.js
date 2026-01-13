import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'crypto'
import { RateLimitedFetcher } from '../nationalPrograms/fetcher.js'

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

export function createFetcher({ userAgent, perHostConcurrency, perHostMinDelayMs, timeoutMs, maxRetries } = {}) {
  return new RateLimitedFetcher({
    userAgent: userAgent || 'GrantFlowNationalCrawler/2.0 (+https://grantflow.app)',
    perHostConcurrency: perHostConcurrency ?? 2,
    perHostMinDelayMs: perHostMinDelayMs ?? 900,
    timeoutMs: timeoutMs ?? 20000,
    maxRetries: maxRetries ?? 2,
  })
}

export async function fetchToBuffer(fetcher, url) {
  const res = await fetcher.fetch(url)
  const status = res?.status ?? null
  const contentType = res?.headers?.get?.('content-type') || null
  const ok = Boolean(res?.ok)
  const buffer = Buffer.from(await res.arrayBuffer())
  return { ok, status, contentType, buffer }
}

export async function fetchFileUrl(url) {
  const u = new URL(url)
  const filePath = fileURLToPath(u)
  const buffer = await fs.readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const contentType =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/html'
  return {
    ok: true,
    status: 200,
    contentType,
    buffer,
    contentHash: sha256(buffer.toString('utf8')),
  }
}

export async function fetchMockUrl(sourceConfig) {
  const payload = sourceConfig?.mock_payload || {}
  const text = JSON.stringify(payload, null, 2)
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
    contentHash: sha256(text),
  }
}

