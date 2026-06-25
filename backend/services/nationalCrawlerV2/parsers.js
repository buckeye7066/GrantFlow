import { parseHtmlToText } from '../nationalPrograms/parsers/html.js'
import { parsePdfToText } from '../nationalPrograms/parsers/pdf.js'
import { parseDocxToText } from '../nationalPrograms/parsers/docx.js'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:nationalCrawlerV2:parsers')

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function parseContent({ url, contentType, buffer, sourceFamily }) {
  try {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase()
    const lowerUrl = String(url || '').toLowerCase()

    if (sourceFamily === 'mock') {
      if (!buffer || !Buffer.isBuffer(buffer)) {
        console.warn(`Invalid buffer for mock source at ${url}`)
        return { parser_name: 'error', extracted_text: '', doc: null }
      }
      const text = normalizeWhitespace(buffer.toString('utf8'))
      return { parser_name: 'mock.json', extracted_text: text, doc: null }
    }

    if (ct.includes('application/pdf') || lowerUrl.endsWith('.pdf')) {
      try {
        const doc = await parsePdfToText(buffer)
        const pdfText = (doc && doc.extractedText) ? doc.extractedText : ''
        if (!pdfText) {
          console.warn(`PDF parser returned empty text for ${url}`)
        }
        return { parser_name: 'pdf-parse', extracted_text: pdfText, doc }
      } catch (pdfError) {
        console.warn(`PDF parsing failed for ${url}:`, pdfError.message)
        // Fall back to treating as HTML
        if (!buffer || !Buffer.isBuffer(buffer)) {
          console.warn(`Invalid buffer for ${url}`)
          return { parser_name: 'error', extracted_text: '', doc: null }
        }
        const fallbackHtmlPdf = buffer.toString('utf8')
        const fallbackPdfDoc = parseHtmlToText(fallbackHtmlPdf, { url })
        return { parser_name: 'cheerio-fallback', extracted_text: fallbackPdfDoc.extractedText, doc: fallbackPdfDoc }
      }
    }

    if (
      ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      lowerUrl.endsWith('.docx')
    ) {
      try {
        const doc = await parseDocxToText(buffer)
        const docxText = (doc && doc.extractedText) ? doc.extractedText : ''
        if (!docxText) {
          console.warn(`DOCX parser returned empty text for ${url}`)
        }
        return { parser_name: 'mammoth', extracted_text: docxText, doc }
      } catch (docxError) {
        console.warn(`DOCX parsing failed for ${url}:`, docxError.message)
        // Fall back to treating as HTML
        if (!buffer || !Buffer.isBuffer(buffer)) {
          console.warn(`Invalid buffer for ${url}`)
          return { parser_name: 'error', extracted_text: '', doc: null }
        }
        const fallbackHtmlDocx = buffer.toString('utf8')
        const fallbackDocxDoc = parseHtmlToText(fallbackHtmlDocx, { url })
        return { parser_name: 'cheerio-fallback', extracted_text: fallbackDocxDoc.extractedText, doc: fallbackDocxDoc }
      }
    }

    // default html
    if (!buffer || !Buffer.isBuffer(buffer)) {
      console.warn(`Invalid buffer for ${url}`)
      return { parser_name: 'error', extracted_text: '', doc: null }
    }
    const defaultHtml = buffer.toString('utf8')
    const defaultDoc = parseHtmlToText(defaultHtml, { url })
    return { parser_name: 'cheerio', extracted_text: defaultDoc.extractedText, doc: defaultDoc }
  } catch (error) {
    qualityLog.error(`Content parsing failed for ${url}:`, error.message)
    return { parser_name: 'error', extracted_text: '', doc: null }
  }
}

