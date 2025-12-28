import path from 'path'
import { fileURLToPath } from 'url'
import { extractDocxText } from './text/docx.js'
import { extractPdfText } from './text/pdf.js'
import { extractImageText } from './text/ocr.js'
import { classifyContent } from './classify.js'
import { extractDriversLicense } from './extract/driversLicense.js'
import { extractScholarshipLetter } from './extract/scholarshipLetter.js'
import { buildPatches } from './patch/buildPatches.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function readTextForDocument(document) {
  const location = document.storage_path
  const ext = path.extname(location).toLowerCase()
  if (ext === '.docx') {
    return extractDocxText(location)
  }
  if (ext === '.pdf') {
    const pdfText = await extractPdfText(location)
    if (pdfText && pdfText.trim().length > 20) {
      return pdfText
    }
    return extractImageText(location)
  }
  if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp'].includes(ext)) {
    return extractImageText(location)
  }
  const { extractPlainText } = await import('./text/plain.js')
  return extractPlainText(location)
}

export async function parseDocument(document, db) {
  const text = await readTextForDocument(document)
  const classification = classifyContent(text)

  let extraction = {}
  if (classification.type === 'drivers_license') {
    extraction = await extractDriversLicense(text)
  } else if (classification.type === 'scholarship_letter') {
    extraction = await extractScholarshipLetter(text)
  } else {
    extraction = { rawText: text }
  }

  const patches = buildPatches(classification.type, extraction, document)

  return {
    docType: classification.type,
    extraction,
    patches,
    confidence: classification.confidence,
  }
}
