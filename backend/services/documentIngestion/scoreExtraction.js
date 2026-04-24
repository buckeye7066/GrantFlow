function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isMostlyWhitespace(text) {
  const s = String(text || '')
  if (!s) return true
  const nonWs = s.replace(/\s+/g, '')
  if (!nonWs) return true
  // If > 95% whitespace, treat as essentially empty
  return nonWs.length / Math.max(1, s.length) < 0.05
}

/**
 * Returns 0.0–1.0 confidence score based on extraction meta.
 *
 * Inputs expected (subset ok):
 * - methods_used: string[]
 * - pages: number|null
 * - char_count: number
 * - avg_chars_per_page: number|null
 * - ocr_used: boolean
 * - ocr_confidence: number|null (0..1)
 * - warnings: string[]
 * - text: string
 */
export function scoreExtraction(meta = {}) {
  const methods = Array.isArray(meta.methods_used) ? meta.methods_used : []
  const ocrUsed = Boolean(meta.ocr_used)
  const charCount = Number(meta.char_count ?? 0) || 0
  const avg = (meta.avg_chars_per_page === null || meta.avg_chars_per_page === undefined) ? null : Number(meta.avg_chars_per_page)
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : []

  if (!meta.text || isMostlyWhitespace(meta.text) || charCount <= 0) {
    return 0.0
  }

  let score = 0.0

  // Base score by method
  if (methods.includes('pdf_text') || methods.includes('docx_text') || methods.includes('txt')) {
    score = 0.85
  } else if (ocrUsed || methods.includes('ocr')) {
    score = 0.75
  } else {
    score = 0.6
  }

  // Volume heuristics
  if (charCount >= 20_000) score += 0.10
  else if (charCount >= 2_000) score += 0.05
  else if (charCount >= 500) score += 0.0
  else {
    // Short documents (letters, notices) can still be highly readable—especially with strong OCR confidence.
    const ocrConf = (meta.ocr_confidence === null || meta.ocr_confidence === undefined) ? null : Number(meta.ocr_confidence)
    const strongOcr = ocrUsed && (ocrConf !== null && ocrConf !== undefined) && Number.isFinite(ocrConf) && clamp01(ocrConf) >= 0.8
    score -= strongOcr ? 0.10 : 0.25
  }

  // Density heuristics for PDFs
  if ((avg !== null && avg !== undefined) && Number.isFinite(avg)) {
    if (avg >= 500) score += 0.05
    else if (avg >= 100) score += 0.0
    else score -= 0.25
  }

  // OCR confidence (if provider supplies it)
  const ocrConf = (meta.ocr_confidence === null || meta.ocr_confidence === undefined) ? null : Number(meta.ocr_confidence)
  if (ocrUsed && (ocrConf !== null && ocrConf !== undefined) && Number.isFinite(ocrConf)) {
    // Use +/- 0.10 range based on OCR confidence.
    score += (clamp01(ocrConf) - 0.75) * 0.4 // center ~0.75 => 0 adjustment
  }

  // Warnings reduce confidence
  const penalty = warnings.some((w) => String(w).toLowerCase().includes('unsupported')) ? 0.35 : 0.0
  score -= penalty
  score -= Math.min(0.25, warnings.length * 0.03)

  // If OCR was used, cap slightly lower (OCR can be great, but less reliable than embedded text).
  if (ocrUsed) score = Math.min(score, 0.93)

  return clamp01(score)
}

