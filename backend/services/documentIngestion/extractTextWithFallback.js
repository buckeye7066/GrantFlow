import { detectFileType } from './detectFileType.js'
import { getOcrProvider } from './ocr/index.js'
import { cleanupPdfPages, pdfToPngPages } from './pdf/pdftoppm.js'
import { extractText } from './extractText.js'
import { countWords, isMostlyWhitespace, normalizeText, nowIso } from './utils.js'
import { scoreExtraction } from './scoreExtraction.js'

function shouldOcrPdf({ extractedText, pages }) {
  const text = String(extractedText || '')
  const trimmed = text.trim()

  const charCount = trimmed.length
  const avgCharsPerPage = pages && pages > 0 ? charCount / Math.max(1, pages) : null
  const mostlyWs = isMostlyWhitespace(text)

  // Implement exactly:
  // - If extracted text < 500 chars -> OCR
  // - OR if pdf pages > 0 AND avg chars/page < 100 -> OCR
  // - OR if pdf extraction yields mostly whitespace -> OCR
  if (charCount < 500) return true
  if (pages && pages > 0 && (avgCharsPerPage !== null && avgCharsPerPage !== undefined) && avgCharsPerPage < 100) return true
  if (mostlyWs) return true
  return false
}

export async function extractTextWithFallback({
  filePath,
  mimeType,
  fileName,
  ocrLanguage = 'eng',
  handwriting = false,
  maxChars = 250_000,
  // For tests: override the initial text extraction step.
  baseExtractFn = null,
  // For tests: allow injecting a PDF rasterizer to avoid external `pdftoppm`.
  pdfRasterize = null,
} = {}) {
  const startedAt = nowIso()
  const warnings = []

  const detected = detectFileType({ filePath, mimeType, fileName })
  const baseExtractor = typeof baseExtractFn === 'function' ? baseExtractFn : extractText
  const base = await baseExtractor({ filePath, mimeType, fileName, maxChars })

  let text = normalizeText(base.text || '')
  let ocrText = null
  let methodsUsed = Array.isArray(base.meta?.methods_used) ? [...base.meta.methods_used] : []
  let pages = base.meta?.pages ?? null
  let ocrUsed = false
  let ocrConfidence = null

  warnings.push(...(Array.isArray(base.meta?.warnings) ? base.meta.warnings : []))

  const provider = getOcrProvider()

  // Images: always OCR.
  if (detected.source_type === 'image') {
    const ocr = await provider.recognize({
      filePath,
      mime: detected.mime,
      language: ocrLanguage,
      handwriting,
    })
    ocrText = normalizeText(ocr?.text || '')
    ocrConfidence = ocr?.confidence ?? null
    ocrUsed = true
    methodsUsed = Array.from(new Set([...methodsUsed, 'ocr']))
    warnings.push(...(Array.isArray(ocr?.warnings) ? ocr.warnings : []))
    if (ocrText) {
      text = ocrText
    } else {
      warnings.push('OCR returned no text for image; retaining base extraction result if available.')
      ocrUsed = false
      ocrConfidence = null
    }
    if (pages !== null && pages !== 1) {
      warnings.push(`Base extractor reported ${pages} pages for an image file; overriding to 1.`)
    }
    pages = 1
  }

  // PDFs: OCR fallback when thresholds are met.
  const effectivelyPdf = detected.source_type === 'pdf' ||
    (detected.source_type !== 'image' && (mimeType === 'application/pdf' || String(fileName || '').toLowerCase().endsWith('.pdf')))

  if (effectivelyPdf) {
    if (detected.source_type !== 'pdf') {
      warnings.push(`File detected as '${detected.source_type}' but mimeType/fileName suggests PDF; attempting PDF OCR fallback.`)
    }
    const shouldOcr = shouldOcrPdf({ extractedText: text, pages })
    if (shouldOcr) {
      let tmpDir = null
      let raster = null
      try {
        raster =
          typeof pdfRasterize === 'function'
            ? await pdfRasterize({
                pdfPath: filePath,
                maxPages: Number(process.env.OCR_PDF_MAX_PAGES || 40) || 40,
                dpi: Number(process.env.OCR_PDF_DPI || 150) || 150,
              })
            : await pdfToPngPages({
                pdfPath: filePath,
                // Keep safe limits; OCR is expensive. If needed we can lift later via env var.
                maxPages: Number(process.env.OCR_PDF_MAX_PAGES || 40) || 40,
                dpi: Number(process.env.OCR_PDF_DPI || 150) || 150,
              })
        tmpDir = raster?.dir ?? null
        const perPageTexts = []
        const perPageConfs = []

        const rasterFiles = Array.isArray(raster?.files) ? raster.files : []
        for (let i = 0; i < rasterFiles.length; i++) {
          const imgPath = rasterFiles[i]
          try {
            const r = await provider.recognize({
              filePath: imgPath,
              mime: 'image/png',
              language: ocrLanguage,
              handwriting,
            })
            const pageText = normalizeText(r?.text || '')
            if (pageText) perPageTexts.push(`\n\n--- Page ${i + 1} (OCR) ---\n${pageText}`)
            if (typeof r?.confidence === 'number' && Number.isFinite(r.confidence)) perPageConfs.push(r.confidence)
            if (Array.isArray(r?.warnings) && r.warnings.length) warnings.push(...r.warnings)
          } catch (pageError) {
            warnings.push(`OCR failed for page ${i + 1}: ${pageError?.message || String(pageError)}`)
          }
        }

        ocrText = normalizeText(perPageTexts.join('\n').trim())
        ocrUsed = true
        methodsUsed = Array.from(new Set([...methodsUsed, 'ocr']))
        if (perPageConfs.length > 0) {
          const avg = perPageConfs.reduce((a, b) => a + b, 0) / perPageConfs.length
          ocrConfidence = avg
        } else if (ocrUsed) {
          // OCR ran but no page returned a finite confidence score
          ocrConfidence = -1
          const allFailed = perPageTexts.length === 0 && rasterFiles.length > 0
          if (allFailed) {
            warnings.push('OCR ran but every page threw an error; ocr_confidence set to -1 as sentinel.')
          } else {
            warnings.push('OCR ran but no page returned a finite confidence value; ocr_confidence set to -1 as sentinel.')
          }
        }

        const baseTrimmed = String(text || '').trim()
        const baseUnusable = !baseTrimmed || isMostlyWhitespace(baseTrimmed) || baseTrimmed.length < 50

        // Prefer OCR when base text is unusable (scanned PDFs), even if OCR text is short.
        // Otherwise, only prefer OCR when it’s substantial.
        if (ocrText && (baseUnusable || ocrText.length >= 100)) {
          text = ocrText
          pages = rasterFiles.length
        } else {
          warnings.push('OCR completed but produced little text; keeping PDF text extraction result.')
          if (!ocrText && rasterFiles.length > 0) {
            warnings.push(`OCR_EMPTY: processed ${rasterFiles.length} page(s) but extracted zero characters — document may be a scanned image with unrecognised content.`)
          }
        }
      } catch (error) {
        // Do not hard-fail the entire ingestion just because OCR tooling is missing.
        // If the PDF is scanned and OCR can't run (e.g., pdftoppm missing), keep the base extraction result
        // and surface a clear warning so admins can fix the environment (or switch OCR providers).
        warnings.push(
          `OCR skipped: ${error?.message || String(error)}`.slice(0, 500),
        )
      } finally {
        if (typeof raster?.cleanup === 'function') {
          try { await raster.cleanup() } catch (_) { /* cleanup best-effort */ }
        } else if (tmpDir) {
          try { await cleanupPdfPages(tmpDir) } catch (_) { /* cleanup best-effort */ }
        }
      }
    }
  }

  const finalText = normalizeText(text || '')
  const charCount = finalText.length
  const wordCount = countWords(finalText)
  const avgCharsPerPage = pages && pages > 0 ? charCount / Math.max(1, pages) : null
  const finishedAt = nowIso()

  const meta = {
    source_type: detected.source_type,
    file_name: fileName ?? null,
    methods_used: methodsUsed,
    pages: pages ?? null,
    char_count: charCount,
    word_count: wordCount,
    avg_chars_per_page: avgCharsPerPage,
    warnings: Array.from(new Set(warnings.filter(Boolean))),
    ocr_used: ocrUsed,
    ocr_confidence: ocrConfidence,
    started_at: startedAt,
    finished_at: finishedAt,
    provenance: {
      extractor: 'grantflow-document-ingestion',
      version: '1',
      ocr_provider: ocrUsed ? provider.id : null,
      timestamps: { started_at: startedAt, finished_at: finishedAt },
    },
  }

  const confidence = scoreExtraction({ ...meta, text: finalText })

  return {
    text: finalText,
    ocr_text: ocrText,
    meta,
    confidence,
  }
}

