import { promises as fsp } from 'fs'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { createWorker } from 'tesseract.js'

function withTimeout(promise, { ms, label }) {
  if (!ms || ms <= 0) return promise
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    }),
    timeoutPromise,
  ])
}

function clampText(text, maxChars) {
  if (!text) return null
  const trimmed = String(text).trim()
  if (!trimmed) return null
  if (!maxChars || trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}

function isImageMime(mimeType) {
  if (!mimeType) return false
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/octet-stream' // some browsers send this for images
  )
}

function isRtfMime(mimeType) {
  const safe = String(mimeType || '').toLowerCase().trim()
  return safe === 'application/rtf' || safe === 'text/rtf'
}

function stripRtfToText(rtf) {
  if (!rtf) return ''
  // Very small, pragmatic RTF → text: remove control words/groups and decode common escapes.
  // We intentionally do not try to fully render RTF formatting.
  return String(rtf)
    // drop \par-like newlines into real newlines
    .replace(/\\par[d]?/gi, '\n')
    // unicode escapes: \uN? (optional fallback char)
    .replace(/\\u(-?\d+)\??/g, (_m, code) => {
      const n = Number(code)
      if (!Number.isFinite(n)) return ''
      try {
        const normalized = ((n % 65536) + 65536) % 65536
        return String.fromCharCode(normalized)
      } catch {
        return ''
      }
    })
    // hex escapes \'hh
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    // remove destinations/groups like {\*\...}
    .replace(/\{\\\*[^{}]*\}/g, '')
    // remove remaining RTF groups/braces
    .replace(/[{}]/g, '')
    // remove control words and control symbols
    .replace(/\\[a-zA-Z]+\d* ?/g, '')
    .replace(/\\[^a-zA-Z0-9]/g, '')
    // normalize whitespace
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function normalizeOcrLanguage(value) {
  const lang = String(value || 'eng').trim()
  // Tesseract expects language codes like "eng" or "eng+spa"
  return lang || 'eng'
}

function normalizeExtension(fileName) {
  const lower = String(fileName || '').toLowerCase()
  const parts = lower.split('.')
  if (parts.length < 2) return ''
  return parts.pop() || ''
}

/**
 * Extract plaintext from an uploaded file.
 * - Supports: PDF, DOCX, TXT, and image OCR (jpg/png/webp/gif/bmp/tiff)
 * - Returns: { text, method, warnings: string[] }
 */
export async function extractTextFromFile({
  filePath,
  mimeType,
  fileName,
  ocr = false,
  handwriting = false,
  ocrLanguage = 'eng',
  timeoutMs = 20_000,
  maxChars = 250_000,
} = {}) {
  const warnings = []
  if (!filePath) {
    return { text: null, method: null, warnings: ['Missing filePath'] }
  }

  const safeMime = String(mimeType || '').trim()
  const ext = normalizeExtension(fileName)

  try {
    // PDFs
    if (safeMime === 'application/pdf' || ext === 'pdf') {
      const buffer = await withTimeout(fsp.readFile(filePath), {
        ms: timeoutMs,
        label: 'Read PDF',
      })
      const result = await withTimeout(pdfParse(buffer), {
        ms: timeoutMs,
        label: 'Parse PDF',
      })
      const text = clampText(result?.text, maxChars)
      if (!text) {
        warnings.push(
          'No text detected in PDF. If this is a scanned document, upload a JPG/PNG (or screenshots of pages) to enable OCR, or export the PDF with selectable text.',
        )
      }
      return { text, method: 'pdf-parse', warnings }
    }

    // DOCX (sometimes browsers mislabel as application/msword or octet-stream; extension is the best hint).
    if (
      safeMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === 'docx'
    ) {
      const buffer = await withTimeout(fsp.readFile(filePath), {
        ms: timeoutMs,
        label: 'Read DOCX',
      })
      const { value } = await withTimeout(mammoth.extractRawText({ buffer }), {
        ms: timeoutMs,
        label: 'Parse DOCX',
      })
      const text = clampText(value, maxChars)
      return { text, method: 'mammoth', warnings }
    }

    // RTF
    if (isRtfMime(safeMime) || ext === 'rtf') {
      const raw = await withTimeout(fsp.readFile(filePath, 'utf8'), {
        ms: timeoutMs,
        label: 'Read RTF',
      })
      const text = clampText(stripRtfToText(raw), maxChars)
      if (!text) warnings.push('RTF parsed, but no readable text was detected.')
      return { text, method: 'rtf', warnings }
    }

    // TXT
    if (safeMime === 'text/plain' || ext === 'txt') {
      const raw = await withTimeout(fsp.readFile(filePath, 'utf8'), {
        ms: timeoutMs,
        label: 'Read TXT',
      })
      const text = clampText(raw, maxChars)
      return { text, method: 'text', warnings }
    }

    // Legacy DOC
    if (safeMime === 'application/msword' || ext === 'doc') {
      return {
        text: null,
        method: 'doc',
        warnings: [
          'Legacy .doc files are not supported for server-side text extraction yet. Please convert to .docx or PDF and re-upload.',
        ],
      }
    }

    // OCR path (images)
    if (ocr && isImageMime(safeMime)) {
      // HEIC/HEIF are commonly unsupported in node OCR pipelines without conversion.
      const lowerName = String(fileName || '').toLowerCase()
      if (lowerName.endsWith('.heic') || lowerName.endsWith('.heif')) {
        return {
          text: null,
          method: 'ocr',
          warnings: [
            'HEIC/HEIF images are not supported for OCR on the server yet. Please convert to JPG or PNG and re-upload.',
          ],
        }
      }

      const lang = normalizeOcrLanguage(ocrLanguage)
      // Tesseract.js API varies by version; support both common init styles.
      let worker = null
      try {
        worker = await createWorker(lang)
      } catch {
        worker = await createWorker()
        try {
          await worker.loadLanguage(lang)
          await worker.initialize(lang)
        } catch {
          // If language init fails, we'll still attempt recognize (may succeed with defaults).
        }
      }
      try {
        try {
          if (handwriting) {
            // Best-effort: tune for sparse/handwritten-like documents. Not perfect, but helps for forms/screenshots.
            await worker.setParameters({
              preserve_interword_spaces: '1',
              tessedit_pageseg_mode: '6',
            })
          }
        } catch {
          // ignore parameter errors; OCR should still run
        }
        const res = await withTimeout(worker.recognize(filePath), {
          ms: Math.max(timeoutMs, 45_000),
          label: 'OCR',
        })
        const text = clampText(res?.data?.text, maxChars)
        if (!text) warnings.push('OCR completed, but no text was detected.')
        return { text, method: `tesseract:${lang}`, warnings }
      } finally {
        try {
          await worker.terminate()
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error))
    return { text: null, method: null, warnings }
  }

  return {
    text: null,
    method: null,
    warnings: [
      `Unsupported file type${mimeType ? ` (${mimeType})` : ''}. Upload PDF, DOCX, TXT, or an image (JPG/PNG) for OCR.`,
    ],
  }
}

