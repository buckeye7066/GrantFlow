import { createTesseractProvider } from './providers/tesseract.js'
import { createAwsTextractProvider } from './providers/awsTextract.js'

let _providerOverride = null

export function __setOcrProviderForTests(provider) {
  _providerOverride = provider || null
}

export function getOcrProvider() {
  if (_providerOverride) return _providerOverride

  const raw = String(process.env.OCR_PROVIDER || 'tesseract').trim().toLowerCase()
  if (raw === 'tesseract') return createTesseractProvider()
  if (raw === 'aws_textract') return createAwsTextractProvider()

  // Feature flags for future providers; keep deterministic failure.
  if (raw === 'google_vision' || raw === 'azure_form_recognizer') {
    throw new Error(`OCR provider "${raw}" is not implemented in this deployment`)
  }

  throw new Error(`Unsupported OCR_PROVIDER "${raw}" (expected tesseract|aws_textract|google_vision|azure_form_recognizer)`)
}

