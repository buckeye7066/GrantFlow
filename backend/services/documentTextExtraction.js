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

function normalizeOcrLanguage(value) {
  const lang = String(value || 'eng').trim()
  // Tesseract expects language codes like "eng" or "eng+spa"
  return lang || 'eng'
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
  ocrLanguage = 'eng',
  timeoutMs = 20_000,
  maxChars = 250_000,
} = {}) {
  const warnings = []
  if (!filePath) {
    return { text: null, method: null, warnings: ['Missing filePath'] }
  }

  const safeMime = mimeType || ''

  try {
    if (safeMime === 'application/pdf') {
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
          'No text detected in PDF. If this is a scanned document, upload an image (JPG/PNG) for OCR, or export the PDF with selectable text.',
        )
      }
      return { text, method: 'pdf-parse', warnings }
    }

    if (
      safeMime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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

    if (safeMime === 'text/plain') {
      const raw = await withTimeout(fsp.readFile(filePath, 'utf8'), {
        ms: timeoutMs,
        label: 'Read TXT',
      })
      const text = clampText(raw, maxChars)
      return { text, method: 'text', warnings }
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

