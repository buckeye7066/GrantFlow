import extractTextFromDocx from './text/docx.js'
import extractTextFromPdf from './text/pdf.js'
import extractTextFromImage from './text/ocr.js'
import classifyDocument from './classify.js'
import extractDriversLicense from './extract/driversLicense.js'
import extractScholarshipLetter from './extract/scholarshipLetter.js'
import {
  extractDates,
  extractEmails,
  extractPhones,
  extractAddresses,
  extractNamePatterns,
  normalizeText,
} from './extract/common.js'
import buildPatches from './patch/buildPatches.js'

/**
 * Main document parser orchestrator
 * Takes uploaded file and extracts structured data
 */
export async function parseDocument(buffer, metadata) {
  const { originalFilename, mimeType } = metadata
  
  const result = {
    text: '',
    docType: 'unknown',
    classification: null,
    extracted: {},
    patches: null,
    error: null,
  }
  
  try {
    // Step 1: Extract text based on file type
    const textResult = await extractText(buffer, mimeType)
    
    if (textResult.error) {
      result.error = textResult.error
      return result
    }
    
    result.text = textResult.text
    
    // Step 2: Classify document type
    const classification = classifyDocument(result.text)
    result.classification = classification
    result.docType = classification.type
    
    // Step 3: Extract structured data based on document type
    if (result.docType === 'drivers_license') {
      result.extracted = extractDriversLicense(result.text)
    } else if (result.docType === 'scholarship_letter') {
      result.extracted = extractScholarshipLetter(result.text)
    } else {
      // For unknown document types, extract general information
      result.extracted = extractGeneralInfo(result.text)
    }
    
    // Step 4: Build patch suggestions
    result.patches = buildPatches(result.extracted, result.docType)
    
  } catch (error) {
    result.error = error.message
  }
  
  return result
}

/**
 * Extract text based on MIME type
 */
async function extractText(buffer, mimeType) {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return await extractTextFromDocx(buffer)
  }
  
  if (mimeType === 'application/pdf') {
    return await extractTextFromPdf(buffer)
  }
  
  if (mimeType.startsWith('image/')) {
    return await extractTextFromImage(buffer)
  }
  
  // For testing: support plain text
  if (mimeType === 'text/plain') {
    return {
      text: buffer.toString('utf-8'),
      error: null,
    }
  }
  
  return {
    text: '',
    error: `Unsupported file type: ${mimeType}`,
  }
}

/**
 * Extract general information from any document
 * This handles unknown document types and extracts common data patterns
 */
function extractGeneralInfo(text) {
  const normalized = normalizeText(text)
  
  const info = {
    summary: null,
    dates: [],
    emails: [],
    phones: [],
    addresses: [],
    names: [],
    text_preview: null,
  }
  
  // Extract common patterns
  info.dates = extractDates(text)
  info.emails = extractEmails(text)
  info.phones = extractPhones(text)
  info.addresses = extractAddresses(text)
  info.names = extractNamePatterns(text)
  
  // Create a text preview (first 500 characters)
  info.text_preview = {
    value: normalized.substring(0, 500) + (normalized.length > 500 ? '...' : ''),
    confidence: 1.0,
  }
  
  // Create a summary of what was found
  const foundItems = []
  if (info.dates.length > 0) foundItems.push(`${info.dates.length} date(s)`)
  if (info.emails.length > 0) foundItems.push(`${info.emails.length} email(s)`)
  if (info.phones.length > 0) foundItems.push(`${info.phones.length} phone(s)`)
  if (info.addresses.length > 0) foundItems.push(`${info.addresses.length} address(es)`)
  if (info.names.length > 0) foundItems.push(`${info.names.length} name(s)`)
  
  info.summary = {
    value: foundItems.length > 0 
      ? `Document contains: ${foundItems.join(', ')}`
      : 'Document parsed successfully',
    confidence: 1.0,
  }
  
  return info
}

export default parseDocument
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
