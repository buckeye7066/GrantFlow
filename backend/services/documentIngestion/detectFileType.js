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

  if (safeMime === 'text/plain' || ext === 'txt') {
    return { source_type: 'text', mime: safeMime || 'text/plain', ext }
  }

  if (safeMime.startsWith('image/') || IMAGE_EXTS.has(ext)) {
    const normalizedMime = safeMime || (ext ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'image/png')
    return { source_type: 'image', mime: normalizedMime, ext }
  }

  // Still return something deterministic; caller can reject unsupported types.
  return { source_type: null, mime: safeMime || null, ext }
}

