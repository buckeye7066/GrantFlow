import { parseHtmlToText } from '../nationalPrograms/parsers/html.js'
import { parsePdfToText } from '../nationalPrograms/parsers/pdf.js'
import { parseDocxToText } from '../nationalPrograms/parsers/docx.js'

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function parseContent({ url, contentType, buffer, sourceFamily }) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  const lowerUrl = String(url || '').toLowerCase()

  if (sourceFamily === 'mock') {
    const text = normalizeWhitespace(buffer.toString('utf8'))
    return { parser_name: 'mock.json', extracted_text: text, doc: null }
  }

  if (ct.includes('application/pdf') || lowerUrl.endsWith('.pdf')) {
    const doc = await parsePdfToText(buffer)
    return { parser_name: 'pdf-parse', extracted_text: doc.extractedText, doc }
  }

  if (
    ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    lowerUrl.endsWith('.docx')
  ) {
    const doc = await parseDocxToText(buffer)
    return { parser_name: 'mammoth', extracted_text: doc.extractedText, doc }
  }

  // default html
  const html = buffer.toString('utf8')
  const doc = parseHtmlToText(html, { url })
  return { parser_name: 'cheerio', extracted_text: doc.extractedText, doc }
}

