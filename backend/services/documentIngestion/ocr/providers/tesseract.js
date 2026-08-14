import { createWorker } from 'tesseract.js'
import { normalizeText } from '../../utils.js'

function normalizeLang(value) {
  const lang = String(value || 'eng').trim()
  return lang || 'eng'
}

export function createTesseractProvider() {
  const provider = {
    id: 'tesseract',

    async recognize({ filePath, mime, pages, language, handwriting } = {}) {
      const lang = normalizeLang(language)
      const warnings = []

      if (!filePath) {
        return { text: '', perPage: null, confidence: null, warnings: ['Missing filePath'] }
      }

      // NOTE: For scanned PDFs we OCR per-page images after rasterization;
      // this provider expects images. If a caller passes PDF bytes directly, results are undefined.
      if (mime && String(mime).toLowerCase().includes('pdf')) {
        return { text: '', perPage: null, confidence: null, warnings: ['PDF files not supported - use rasterized images'] }
      }

      let worker = null
      try {
        // Support both common init styles (tesseract.js versions vary).
        try {
          worker = await createWorker(lang)
        } catch {
          worker = await createWorker()
          try {
            await worker.loadLanguage(lang)
            await worker.initialize(lang)
          } catch (langErr) {
            warnings.push(`Language init failed for '${lang}': ${langErr?.message ?? langErr} — OCR quality may be degraded`)
          }
        }

        try {
          if (handwriting) {
            await worker.setParameters({
              preserve_interword_spaces: '1',
              tessedit_pageseg_mode: '6',
            })
          }
        } catch {
          // ignore parameter errors
        }

        const res = await worker.recognize(filePath)
        const text = normalizeText(res?.data?.text || '')

        // Tesseract reports confidence as 0..100 in some builds; normalize to 0..1 when possible.
        const rawConf = res?.data?.confidence
        const conf =
          typeof rawConf === 'number' && Number.isFinite(rawConf)
            ? rawConf > 1
              ? Math.max(0, Math.min(1, rawConf / 100))
              : Math.max(0, Math.min(1, rawConf))
            : null

        return {
          text,
          perPage: null,
          confidence: conf,
          warnings,
        }
      } finally {
        try {
          await worker?.terminate()
        } catch {
          // ignore cleanup errors
        }
      }
    },
  }

  return provider
}

