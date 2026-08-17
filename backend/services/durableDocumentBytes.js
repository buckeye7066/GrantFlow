import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

function documentBytesError(code, message, status = 422) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function sha256DocumentBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw documentBytesError('DOCUMENT_BYTES_INVALID', 'Document bytes must be a Buffer.', 400)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Re-read an upload after its security scan and prove the persisted bytes are
 * the same bytes the scanner approved. The caller stores both returned values
 * in documents.file_bytes/content_hash in the same INSERT.
 */
export async function readValidatedUploadBytes(file) {
  if (!file?.path) {
    throw documentBytesError('UPLOAD_FILE_MISSING', 'The uploaded file could not be read.', 400)
  }
  const bytes = await fs.readFile(file.path)
  const contentHash = sha256DocumentBytes(bytes)
  const validatedHash = String(file.securityValidation?.sha256 || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(validatedHash) || validatedHash !== contentHash) {
    throw documentBytesError(
      'UPLOAD_INTEGRITY_MISMATCH',
      'The uploaded file changed after security validation.',
    )
  }
  if (file.size !== null && file.size !== undefined && Number(file.size) !== bytes.length) {
    throw documentBytesError(
      'UPLOAD_SIZE_MISMATCH',
      'The uploaded file size changed after security validation.',
    )
  }
  return { bytes, contentHash }
}

/** Verify a durable DB document before any parser receives its bytes. */
export function verifyDurableDocumentBytes(document, { codePrefix = 'DOCUMENT' } = {}) {
  const bytes = Buffer.isBuffer(document?.file_bytes)
    ? document.file_bytes
    : document?.file_bytes instanceof Uint8Array
      ? Buffer.from(document.file_bytes)
      : null
  if (!bytes?.length) {
    throw documentBytesError(
      `${codePrefix}_BYTES_REQUIRED`,
      'This document has no durable bytes. Upload it again before parsing.',
    )
  }

  const expectedHash = String(document?.content_hash || '').trim().toLowerCase()
  const actualHash = sha256DocumentBytes(bytes)
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
    throw documentBytesError(
      `${codePrefix}_INTEGRITY_FAILED`,
      'The stored document failed its integrity check. Upload it again before parsing.',
    )
  }
  if (
    document?.file_size !== null
    && document?.file_size !== undefined
    && Number(document.file_size) !== bytes.length
  ) {
    throw documentBytesError(
      `${codePrefix}_SIZE_MISMATCH`,
      'The stored document size does not match its durable bytes.',
    )
  }
  return { bytes, contentHash: actualHash }
}

export default {
  readValidatedUploadBytes,
  sha256DocumentBytes,
  verifyDurableDocumentBytes,
}
