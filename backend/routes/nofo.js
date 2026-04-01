import express from 'express'
import pdfParse from 'pdf-parse'
import fetch from 'node-fetch'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'

const router = express.Router()

const MAX_TEXT_CHARS = Number(process.env.NOFO_PARSE_MAX_TEXT_CHARS || 14_000)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function tryExtractFirstJson(text) {
  const raw = String(text || '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch (error) {
    console.warn('[tryExtractFirstJson] Parse failed:', error.message)
    return null
  }
}

async function fetchPdfTextFromUrl(fileUrl) {
  const resp = await fetch(fileUrl, {
    headers: {
      // Grants.gov and some provider sites require a User-Agent to return the full document/page.
      'User-Agent': 'GrantFlow NOFO Parser (+https://app.axiombiolabs.org)',
      Accept: 'text/html,application/pdf;q=0.9,*/*;q=0.8',
    },
  })
  if (!resp.ok) {
    const err = new Error(`Failed to fetch file (HTTP ${resp.status})`)
    err.status = resp.status
    throw err
  }
  const contentType = String(resp.headers.get('content-type') || '').toLowerCase()

  // Some callers pass a web page URL (e.g. grants.gov detail pages). In those cases,
  // pdf-parse will throw because the payload is HTML. Treat non-PDF content as text/HTML
  // and extract a best-effort plain-text representation.
  const buf = Buffer.from(await resp.arrayBuffer())
  const asString = () => {
    try {
      return buf.toString('utf8')
    } catch (error) {
      console.warn('[fetchPdfTextFromUrl] String conversion failed:', error.message)
      return ''
    }
  }

  const looksLikePdf =
    contentType.includes('application/pdf') ||
    (buf.length >= 5 && buf.subarray(0, 5).toString('utf8') === '%PDF-')

  if (looksLikePdf) {
    const parsed = await pdfParse(buf)
    const text = String(parsed?.text || '').trim()
    return { text, contentType, bytes: buf.length }
  }

  // HTML/text fallback
  const raw = asString()
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = withoutScripts
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return { text, contentType, bytes: buf.length }
}

function heuristicFallback(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const title = lines.find((l) => l.length >= 8 && l.length <= 140) || null
  return { title, funder: null }
}

// POST /api/parseNOFO
// Body: { file_url: string, json_schema?: object, is_url?: boolean }
router.post('/parseNOFO', async (req, res) => {
  try {
    const fileUrl = typeof req.body?.file_url === 'string' ? req.body.file_url.trim() : ''
    const schema = req.body?.json_schema && typeof req.body.json_schema === 'object' ? req.body.json_schema : null
    const isUrl = req.body?.is_url === true || req.body?.is_url === 'true'

    if (!fileUrl) {
      return res.status(400).json({ success: false, message: 'file_url is required' })
    }

    const { text, contentType } = await fetchPdfTextFromUrl(fileUrl)
    if (!text) {
      console.warn('[parseNOFO] Empty text extracted from URL:', fileUrl, '| contentType:', contentType)
      return res.status(422).json({
        success: false,
        message: contentType.includes('pdf')
          ? 'No extractable text found in document (may be scanned images).'
          : isUrl
            ? 'No extractable text found at the provided URL.'
            : 'No extractable text found in document.',
      })
    }

    const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text

    const system =
      'You extract grant NOFO information from documents. ' +
      'Only return information supported by the provided text. Do not invent facts.'

    const prompt =
      `Extract a JSON object from this NOFO.\n\n` +
      (schema ? `JSON SCHEMA (use these keys/types):\n${JSON.stringify(schema, null, 2)}\n\n` : '') +
      `NOFO TEXT:\n${clipped}\n\n` +
      `Return ONLY a valid JSON object.`

    const openai = getOpenAIOptional()
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 1800,
        })

        const raw = completion.choices?.[0]?.message?.content
        const parsed = raw ? tryExtractFirstJson(raw) : null
        if (parsed && typeof parsed === 'object') {
          return res.json({ success: true, output: parsed, ai_provider: 'openai' })
        }
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        console.warn('[parseNOFO] OpenAI failed, trying Anthropic:', summary?.message || error?.message || error)
      }
    }

    const anthropic = await createAnthropicClient()
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
          max_tokens: 1800,
          temperature: 0.1,
          system,
          messages: [{ role: 'user', content: prompt }],
        })
        const raw = extractAnthropicText(response)
        const parsed = raw ? tryExtractFirstJson(raw) : null
        if (parsed && typeof parsed === 'object') {
          return res.json({ success: true, output: parsed, ai_provider: 'anthropic' })
        }
      } catch (error) {
        console.warn('[parseNOFO] Anthropic failed:', error?.message || error)
      }
    }

    // No provider available or both failed: return a minimal best-effort object so the UI can proceed.
    return res.json({
      success: false,
      output: heuristicFallback(clipped),
      ai_provider: 'fallback',
      partial: true,
      warning: 'AI provider unavailable; returned best-effort extraction. Do not store this record without manual review.',
    })
  } catch (error) {
    console.error('[parseNOFO] Failed:', error)
    const status = Number(error?.status)
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      return res.status(status).json({
        success: false,
        message:
          status === 403
            ? 'The source site blocked the request (403). Try using a direct PDF URL instead of a webpage.'
            : error?.message || 'Unable to fetch the provided URL',
        error_type: 'nofo_fetch_failed',
      })
    }
    return res.status(500).json({
      success: false,
      message: 'parseNOFO failed',
      error_type: 'nofo_parse_failed',
      details: process.env.NODE_ENV === 'production' ? undefined : (error?.message || String(error)),
    })
  }
})

export default router

