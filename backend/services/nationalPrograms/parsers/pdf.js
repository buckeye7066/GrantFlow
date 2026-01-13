import pdfParse from 'pdf-parse'

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function parsePdfToText(buffer) {
  const data = await pdfParse(buffer)
  const text = normalizeWhitespace(data?.text || '')
  const extractedText = text.length > 200000 ? text.slice(0, 200000) : text
  return {
    contentType: 'application/pdf',
    title: null,
    h1: null,
    extractedText,
    links: [],
  }
}

