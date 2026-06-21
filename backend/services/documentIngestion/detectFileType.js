import path from 'node:path'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png'])

export function detectFileType({ filePath, mimeType, fileName } = {}) {
  const safeMime = String(mimeType || '').toLowerCase().trim()
  const ext = (() => {
    const fromName = String(fileName || '').trim()
    const candidate = fromName ? fromName : filePath ? path.basename(String(filePath)) : ''
    const parts = candidate.split('.')
    return parts.length > 1 ? String(parts[parts.length - 1]).toLowerCase() : ''
  })()

  if (safeMime === 'application/pdf' || ext === 'pdf') {
    return { source_type: 'pdf', mime: safeMime || 'application/pdf', ext }
  }

  if (
    safeMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return {
      source_type: 'docx',
      mime: safeMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext,
    }
  }

  // Plain text, web pages (URL imports arrive as text/html), and other readable
  // text formats all extract to text. The document_extracts.source_type CHECK
  // only allows docx|pdf|image|text, so web/text-ish content MUST map to 'text'
  // (a URL import previously fell through to 'unknown' and violated the CHECK).
  const TEXT_EXTS = new Set(['txt', 'text', 'html', 'htm', 'md', 'markdown', 'csv', 'json', 'rtf', 'xhtml'])
  if (
    safeMime === 'text/plain' ||
    safeMime === 'text/html' ||
    safeMime === 'application/xhtml+xml' ||
    safeMime.startsWith('text/') ||
    TEXT_EXTS.has(ext)
  ) {
    return { source_type: 'text', mime: safeMime || 'text/plain', ext }
  }

  if (safeMime.startsWith('image/') || IMAGE_EXTS.has(ext)) {
    const normalizedMime = safeMime || (ext ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'image/png')
    return { source_type: 'image', mime: normalizedMime, ext }
  }

  // Still return something deterministic; caller can reject unsupported types.
  return { source_type: 'unknown', mime: safeMime || null, ext }
}

