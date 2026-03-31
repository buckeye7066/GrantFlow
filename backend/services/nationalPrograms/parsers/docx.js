import mammoth from 'mammoth'

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function parseDocxToText(buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer })
    const text = normalizeWhitespace(value || '')
  const extractedText = text.length > 200000 ? text.slice(0, 200000) + '\n[CONTENT_TRUNCATED]' : text
  return {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    title: null,
    h1: null,
    extractedText,
    links: [],
  }
}

