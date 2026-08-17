import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import AdmZip from 'adm-zip'

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
const CLAMAV_CHUNK_BYTES = 64 * 1024

const EXTENSION_KIND = Object.freeze({
  pdf: 'pdf',
  doc: 'doc',
  docx: 'docx',
  txt: 'text',
  html: 'html',
  htm: 'html',
  rtf: 'rtf',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  heic: 'heic',
  heif: 'heic',
})

const KIND_MIME_TYPES = Object.freeze({
  pdf: new Set(['application/pdf']),
  doc: new Set(['application/msword', 'application/octet-stream']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream']),
  text: new Set(['text/plain', 'application/octet-stream']),
  html: new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'application/octet-stream']),
  rtf: new Set(['application/rtf', 'text/rtf', 'text/plain', 'application/octet-stream']),
  jpeg: new Set(['image/jpeg', 'image/jpg', 'application/octet-stream']),
  png: new Set(['image/png', 'application/octet-stream']),
  webp: new Set(['image/webp', 'application/octet-stream']),
  gif: new Set(['image/gif', 'application/octet-stream']),
  bmp: new Set(['image/bmp', 'application/octet-stream']),
  tiff: new Set(['image/tiff', 'application/octet-stream']),
  heic: new Set(['image/heic', 'image/heif', 'application/octet-stream']),
})

export class UploadValidationError extends Error {
  constructor(code, message, status = 415) {
    super(message)
    this.name = 'UploadValidationError'
    this.code = code
    this.status = status
    this.statusCode = status
  }
}

function begins(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false
  return bytes.every((value, index) => buffer[index] === value)
}

function isProbablyText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024))
  if (sample.includes(0)) return false
  let controls = 0
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1
  }
  return controls / sample.length < 0.01
}

function inspectDocx(buffer) {
  try {
    const archive = new AdmZip(buffer)
    const entries = archive.getEntries()
    if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) return false
    let totalBytes = 0
    let hasContentTypes = false
    let hasWordDocument = false
    for (const entry of entries) {
      const name = String(entry.entryName || '').replace(/\\/g, '/')
      if (!name || name.startsWith('/') || name.split('/').includes('..')) return false
      totalBytes += Number(entry.header?.size || 0)
      if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) return false
      if (name === '[Content_Types].xml') hasContentTypes = true
      if (name === 'word/document.xml') hasWordDocument = true
    }
    return hasContentTypes && hasWordDocument
  } catch {
    return false
  }
}

export function detectUploadKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf'
  if (begins(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc'
  if (begins(buffer, [0x50, 0x4b, 0x03, 0x04]) && inspectDocx(buffer)) return 'docx'
  if (begins(buffer, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (begins(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp'
  if (begins(buffer, [0x49, 0x49, 0x2a, 0x00]) || begins(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 16).toString('ascii').toLowerCase()
    if (/hei[cf]|mif1|msf1/.test(brand)) return 'heic'
  }
  const prefix = buffer.subarray(0, 16).toString('ascii').replace(/^\uFEFF/, '').trimStart()
  if (/^\{\\rtf/i.test(prefix)) return 'rtf'
  const textPrefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').trimStart()
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(textPrefix)) return 'html'
  if (isProbablyText(buffer)) return 'text'
  return null
}

function normalizedExtension(originalName) {
  const ext = path.extname(String(originalName || '')).slice(1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

function assertNoKnownMalwareMarker(buffer) {
  // The EICAR marker is the safe industry-standard antivirus test string. It
  // must never survive ingestion; checking it here also proves uploads are
  // inspected after bytes arrive rather than trusted from browser metadata.
  if (buffer.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE', 'ascii'))) {
    throw new UploadValidationError('UPLOAD_MALWARE_MARKER_DETECTED', 'The uploaded file failed the security scan.', 422)
  }
}

function envEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim())
}

export function interpretClamAvResponse(value) {
  const response = String(value || '').replace(/\0/g, '').trim()
  if (/\bOK$/i.test(response)) return { clean: true, response }
  const found = /:\s*(.+?)\s+FOUND$/i.exec(response)
  if (found) return { clean: false, threat: found[1], response }
  throw new UploadValidationError(
    'UPLOAD_MALWARE_SCAN_INVALID_RESPONSE',
    'The malware scanner returned an invalid response.',
    503,
  )
}

/**
 * Scan bytes with clamd's INSTREAM protocol. Deployments may set
 * CLAMAV_REQUIRED=true to fail closed whenever the scanner is absent or down.
 */
export async function scanUploadBufferWithClamAv(buffer, options = {}) {
  const host = String(options.host ?? process.env.CLAMAV_HOST ?? '').trim()
  const port = Number(options.port ?? process.env.CLAMAV_PORT ?? 3310)
  const required = options.required ?? envEnabled(process.env.CLAMAV_REQUIRED)
  const requestedTimeout = Number(options.timeoutMs ?? process.env.CLAMAV_TIMEOUT_MS ?? 10_000)
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(250, requestedTimeout) : 10_000

  if (!host) {
    if (required) {
      throw new UploadValidationError(
        'UPLOAD_MALWARE_SCANNER_UNAVAILABLE',
        'Uploads are temporarily unavailable because the malware scanner is not configured.',
        503,
      )
    }
    return { scanner: 'clamav', status: 'not_configured', clean: null }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UploadValidationError(
      'UPLOAD_MALWARE_SCANNER_CONFIG_INVALID',
      'The malware scanner configuration is invalid.',
      503,
    )
  }

  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      const parts = []
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        socket.destroy()
        callback(value)
      }
      socket.setTimeout(timeoutMs)
      socket.on('connect', () => {
        socket.write('zINSTREAM\0')
        for (let offset = 0; offset < buffer.length; offset += CLAMAV_CHUNK_BYTES) {
          const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + CLAMAV_CHUNK_BYTES))
          const length = Buffer.allocUnsafe(4)
          length.writeUInt32BE(chunk.length, 0)
          socket.write(length)
          socket.write(chunk)
        }
        socket.end(Buffer.alloc(4))
      })
      socket.on('data', (chunk) => parts.push(Buffer.from(chunk)))
      socket.on('end', () => finish(resolve, Buffer.concat(parts).toString('utf8')))
      socket.on('timeout', () => finish(reject, new Error('clamav_timeout')))
      socket.on('error', (error) => finish(reject, error))
    })
    const verdict = interpretClamAvResponse(response)
    if (!verdict.clean) {
      throw new UploadValidationError(
        'UPLOAD_MALWARE_DETECTED',
        'The uploaded file failed the malware scan.',
        422,
      )
    }
    return { scanner: 'clamav', status: 'clean', clean: true }
  } catch (error) {
    if (error instanceof UploadValidationError) throw error
    if (required) {
      throw new UploadValidationError(
        'UPLOAD_MALWARE_SCANNER_UNAVAILABLE',
        'Uploads are temporarily unavailable because the malware scanner could not be reached.',
        503,
      )
    }
    return { scanner: 'clamav', status: 'unavailable', clean: null }
  }
}

export function validateUploadBuffer({
  buffer,
  originalName,
  mimetype,
  allowedKinds = null,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new UploadValidationError('UPLOAD_EMPTY', 'The uploaded file is empty.', 400)
  }
  assertNoKnownMalwareMarker(buffer)

  const extension = normalizedExtension(originalName)
  const extensionKind = EXTENSION_KIND[extension] || null
  const detectedKind = detectUploadKind(buffer)
  if (!extensionKind || !detectedKind) {
    throw new UploadValidationError('UPLOAD_TYPE_UNVERIFIED', 'The file type could not be verified from its content.')
  }
  if (extensionKind !== detectedKind) {
    throw new UploadValidationError('UPLOAD_EXTENSION_MISMATCH', 'The file content does not match its filename extension.')
  }
  if (Array.isArray(allowedKinds) && !allowedKinds.includes(detectedKind)) {
    throw new UploadValidationError('UPLOAD_TYPE_NOT_ALLOWED', 'This file type is not allowed for this upload.')
  }

  const normalizedMime = String(mimetype || '').split(';')[0].trim().toLowerCase()
  const allowedMimes = KIND_MIME_TYPES[detectedKind] || new Set()
  if (normalizedMime && !allowedMimes.has(normalizedMime)) {
    throw new UploadValidationError('UPLOAD_MIME_MISMATCH', 'The file content does not match its declared media type.')
  }

  return {
    kind: detectedKind,
    extension,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  }
}

export async function validateUploadBufferSecure(input = {}, options = {}) {
  const validation = validateUploadBuffer(input)
  const scanner = typeof options.scanner === 'function'
    ? options.scanner
    : scanUploadBufferWithClamAv
  const malwareScan = await scanner(input.buffer, options.clamav)
  return { ...validation, malwareScan }
}

export async function validateUploadedFile(file, options = {}) {
  if (!file?.path) {
    throw new UploadValidationError('UPLOAD_FILE_MISSING', 'The uploaded file could not be read.', 400)
  }
  const buffer = await fs.readFile(file.path)
  const { scanner, clamav, ...validationOptions } = options
  return validateUploadBufferSecure({
    buffer,
    originalName: file.originalname,
    mimetype: file.mimetype,
    ...validationOptions,
  }, { scanner, clamav })
}

export default {
  detectUploadKind,
  interpretClamAvResponse,
  scanUploadBufferWithClamAv,
  validateUploadBuffer,
  validateUploadBufferSecure,
  validateUploadedFile,
}
