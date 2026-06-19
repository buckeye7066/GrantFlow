import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'crypto'
import { RateLimitedFetcher } from '../nationalPrograms/fetcher.js'
import { assertSsrfSafeUrl } from '../../config/urlRules.js'

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
  // SSRF guard: seed/redirect URLs can be data-driven, so refuse to fetch any host
  // that resolves to a private/loopback/link-local address (e.g. cloud metadata).
  const ssrf = await assertSsrfSafeUrl(url)
  if (!ssrf.ok) {
    return { ok: false, status: null, contentType: null, buffer: null, error: `ssrf_blocked:${ssrf.reason}`, errorType: 'ssrf' }
  }
  let res; try { res = await fetcher.fetch(url); } catch (error) { return { ok: false, status: null, contentType: null, buffer: null, error: error.message, errorType: 'network' }; }
  const status = res?.status ?? null
  const contentType = res?.headers?.get?.('content-type') || null
  const ok = Boolean(res?.ok)
  if (!res || typeof res.arrayBuffer !== 'function') {
    return { ok: false, status, contentType, buffer: null, error: 'Response object missing arrayBuffer method' };
  }
  let buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return { ok: false, status, contentType, buffer: null, error: `Failed to read response body: ${error.message}` };
  }
  return { ok, status, contentType, buffer, contentHash: sha256(buffer.toString('base64')) }
}

export async function fetchFileUrl(url) {
  const u = new URL(url)
  let filePath; try { filePath = fileURLToPath(u); } catch (error) { return { ok: false, status: 400, contentType: null, buffer: null, error: 'Invalid file URL' }; }
  let buffer; try { buffer = await fs.readFile(filePath); } catch (error) { return { ok: false, status: 404, contentType: null, buffer: null, error: `File not found: ${filePath}` }; }
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
    contentHash: sha256(buffer.toString('base64')),
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

