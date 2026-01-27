import { promises as fsp } from 'node:fs'
import mammoth from 'mammoth'
import pdfParse from 'pdf-parse'
import { detectFileType } from './detectFileType.js'
import { countWords, isMostlyWhitespace, normalizeText } from './utils.js'

function clampText(text, maxChars = 250_000) {
  const s = normalizeText(text || '')
  if (!s) return ''
  if (!maxChars || s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}…`
}

export async function extractText({ filePath, mimeType, fileName, maxChars } = {}) {
  const warnings = []
  const detected = detectFileType({ filePath, mimeType, fileName })

  if (!filePath) {
    return {
      text: '',
      meta: {
        source_type: detected.source_type,
        methods_used: [],
        pages: null,
        char_count: 0,
        word_count: 0,
        warnings: ['Missing filePath'],
      },
    }
  }

  if (detected.source_type === 'text') {
    const raw = await fsp.readFile(filePath, 'utf8').catch(() => '')
    const text = clampText(raw, maxChars)
    return {
      text,
      meta: {
        source_type: 'text',
        methods_used: ['txt'],
        pages: null,
        char_count: text.length,
        word_count: countWords(text),
        warnings,
      },
    }
  }

  if (detected.source_type === 'docx') {
    const buffer = await fsp.readFile(filePath)
    const { value } = await mammoth.extractRawText({ buffer })
    const text = clampText(value, maxChars)
    return {
      text,
      meta: {
        source_type: 'docx',
        methods_used: ['docx_text'],
        pages: null,
        char_count: text.length,
        word_count: countWords(text),
        warnings,
      },
    }
  }

  if (detected.source_type === 'pdf') {
    const buffer = await fsp.readFile(filePath)
    const parsed = await pdfParse(buffer)
    const text = clampText(parsed?.text || '', maxChars)
    const pages = typeof parsed?.numpages === 'number' && Number.isFinite(parsed.numpages) ? parsed.numpages : null
    if (!text || isMostlyWhitespace(text)) warnings.push('PDF text extraction returned little or no selectable text.')

    return {
      text,
      meta: {
        source_type: 'pdf',
        methods_used: ['pdf_text'],
        pages,
        char_count: text.length,
        word_count: countWords(text),
        avg_chars_per_page: pages ? text.length / Math.max(1, pages) : null,
        warnings,
      },
    }
  }

  if (detected.source_type === 'image') {
    // Images require OCR; return empty text here so the fallback path can kick in deterministically.
    return {
      text: '',
      meta: {
        source_type: 'image',
        methods_used: [],
        pages: 1,
        char_count: 0,
        word_count: 0,
        warnings: ['Image requires OCR'],
      },
    }
  }

  return {
    text: '',
    meta: {
      source_type: detected.source_type,
      methods_used: [],
      pages: null,
      char_count: 0,
      word_count: 0,
      warnings: [`Unsupported file type${detected.mime ? ` (${detected.mime})` : ''}`],
    },
  }
}

