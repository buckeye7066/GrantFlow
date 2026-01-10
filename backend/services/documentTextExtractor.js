import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import Tesseract from 'tesseract.js'
import heicConvert from 'heic-convert'

function normalizeMimeType(value) {
  if (!value) return null
  return String(value).trim().toLowerCase()
}

function normalizeExtension(filePath, fallbackName = null) {
  const extFromPath = filePath ? path.extname(filePath) : ''
  const extFromName = fallbackName ? path.extname(fallbackName) : ''
  const ext = (extFromPath || extFromName || '').toLowerCase()
  return ext.startsWith('.') ? ext.slice(1) : ext
}

function stripRtfToText(rtf) {
  if (!rtf) return ''
  let text = String(rtf)
  // Remove RTF header braces and groups as best-effort.
  text = text.replace(/\{\\\*\\[^}]+\}/g, ' ')
  text = text.replace(/\{\\fonttbl[\s\S]*?\}/g, ' ')
  text = text.replace(/\{\\colortbl[\s\S]*?\}/g, ' ')
  text = text.replace(/\{\\stylesheet[\s\S]*?\}/g, ' ')
  // Decode \'hh hex escapes.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16))
    } catch {
      return ''
    }
  })
  // Convert common paragraph / line markers.
  text = text.replace(/\\par[d]?/g, '\n')
  text = text.replace(/\\line/g, '\n')
  text = text.replace(/\\tab/g, '\t')
  // Drop control words.
  text = text.replace(/\\[a-zA-Z]+\d* ?/g, ' ')
  // Remove braces and remaining escapes.
  text = text.replace(/[{}]/g, ' ')
  text = text.replace(/\\[\\{}]/g, ' ')
  // Cleanup whitespace.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  text = text.replace(/[ \t]+\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]{2,}/g, ' ')
  return text.trim()
}

function isImageLike(mimeType, extension) {
  if (mimeType?.startsWith('image/')) return true
  return new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif']).has(extension)
}

async function ocrImageBuffer(buffer, options = {}) {
  const lang = options.language || 'eng'
  const config = options.tesseractConfig || {}
  const result = await Tesseract.recognize(buffer, lang, {
    logger: options.logger || undefined,
    ...config,
  })
  const text = result?.data?.text?.trim()
  return text && text.length > 0 ? text : null
}

async function loadImageBufferForOcr(filePath, extension) {
  const buffer = await fsp.readFile(filePath)
  if (extension === 'heic' || extension === 'heif') {
    // Convert HEIC/HEIF to PNG buffer for OCR.
    const outputBuffer = await heicConvert({
      buffer,
      format: 'PNG',
      quality: 1,
    })
    return outputBuffer
  }
  return buffer
}

export async function extractTextFromFile({
  filePath,
  mimeType,
  fileName = null,
  ocr = true,
  handwriting = false,
  ocrLanguage = 'eng',
} = {}) {
  if (!filePath) return { text: null, method: null, warnings: ['missing_file_path'] }
  if (!fs.existsSync(filePath)) return { text: null, method: null, warnings: ['file_not_found'] }

  const normalizedMime = normalizeMimeType(mimeType)
  const extension = normalizeExtension(filePath, fileName)
  const warnings = []

  try {
    // PDF
    if (normalizedMime === 'application/pdf' || extension === 'pdf') {
      const buffer = await fsp.readFile(filePath)
      const result = await pdfParse(buffer)
      const text = result?.text?.trim()
      if (text && text.length > 0) return { text, method: 'pdf-parse', warnings }

      // Best-effort note: scanned PDFs require PDF rendering to images, which we intentionally avoid here.
      warnings.push('pdf_text_empty_or_scanned')
      return { text: null, method: 'pdf-parse', warnings }
    }

    // DOCX
    if (
      normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      extension === 'docx'
    ) {
      const buffer = await fsp.readFile(filePath)
      const { value } = await mammoth.extractRawText({ buffer })
      const text = value?.trim()
      return { text: text && text.length > 0 ? text : null, method: 'mammoth', warnings }
    }

    // DOC (legacy Word 97-2003)
    if (normalizedMime === 'application/msword' || extension === 'doc') {
      const extractor = new WordExtractor()
      const doc = await extractor.extract(filePath)
      const text = doc?.getBody?.()?.trim?.() || doc?.getBody?.() || null
      return { text: text && String(text).trim().length > 0 ? String(text).trim() : null, method: 'word-extractor', warnings }
    }

    // TXT
    if (normalizedMime === 'text/plain' || extension === 'txt') {
      const buffer = await fsp.readFile(filePath, 'utf8')
      const text = buffer?.toString()?.trim()
      return { text: text && text.length > 0 ? text : null, method: 'plain-text', warnings }
    }

    // RTF
    if (normalizedMime === 'application/rtf' || normalizedMime === 'text/rtf' || extension === 'rtf') {
      const rtf = await fsp.readFile(filePath, 'utf8')
      const text = stripRtfToText(rtf)
      return { text: text && text.length > 0 ? text : null, method: 'rtf-strip', warnings }
    }

    // Images (OCR / handwriting)
    if (ocr && isImageLike(normalizedMime, extension)) {
      const buffer = await loadImageBufferForOcr(filePath, extension)
      const text = await ocrImageBuffer(buffer, {
        language: ocrLanguage,
        // Handwriting is best-effort; we currently just enable OCR and can add preprocessing later.
        tesseractConfig: handwriting ? {} : {},
      })
      return { text, method: extension === 'heic' || extension === 'heif' ? 'ocr:tesseract+heic-convert' : 'ocr:tesseract', warnings }
    }
  } catch (error) {
    warnings.push('extraction_error')
    return { text: null, method: null, warnings: [...warnings, error instanceof Error ? error.message : String(error)] }
  }

  warnings.push('unsupported_type')
  return { text: null, method: null, warnings }
}

