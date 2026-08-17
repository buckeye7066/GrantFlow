import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import {
  UploadValidationError,
  detectUploadKind,
  interpretClamAvResponse,
  validateUploadBuffer,
  validateUploadBufferSecure,
} from '../../backend/utils/uploadFileValidation.js'

function minimalDocx() {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  zip.addFile('word/document.xml', Buffer.from('<w:document/>'))
  return zip.toBuffer()
}

test('upload validation accepts content that agrees with extension and MIME', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
  const result = validateUploadBuffer({
    buffer: pdf,
    originalName: 'application.pdf',
    mimetype: 'application/pdf',
  })
  assert.equal(result.kind, 'pdf')
  assert.equal(result.sha256.length, 64)

  const docx = minimalDocx()
  assert.equal(detectUploadKind(docx), 'docx')
  assert.equal(validateUploadBuffer({
    buffer: docx,
    originalName: 'request.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }).kind, 'docx')
})

test('upload validation rejects extension and MIME spoofing', () => {
  const executable = Buffer.from('MZ\u0090\u0000not a pdf', 'latin1')
  assert.throws(
    () => validateUploadBuffer({ buffer: executable, originalName: 'malware.pdf', mimetype: 'application/pdf' }),
    (error) => error instanceof UploadValidationError && error.code === 'UPLOAD_TYPE_UNVERIFIED',
  )

  const pdf = Buffer.from('%PDF-1.7\n')
  assert.throws(
    () => validateUploadBuffer({ buffer: pdf, originalName: 'photo.png', mimetype: 'image/png' }),
    (error) => error instanceof UploadValidationError && error.code === 'UPLOAD_EXTENSION_MISMATCH',
  )
})

test('upload validation rejects the standard antivirus marker after bytes arrive', () => {
  const marker = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  assert.throws(
    () => validateUploadBuffer({ buffer: marker, originalName: 'scan.txt', mimetype: 'text/plain' }),
    (error) => error instanceof UploadValidationError && error.code === 'UPLOAD_MALWARE_MARKER_DETECTED',
  )
})

test('secure validation records a clean external malware verdict', async () => {
  const pdf = Buffer.from('%PDF-1.7\n')
  const result = await validateUploadBufferSecure({
    buffer: pdf,
    originalName: 'application.pdf',
    mimetype: 'application/pdf',
  }, {
    scanner: async (received) => {
      assert.equal(received, pdf)
      return { scanner: 'clamav', status: 'clean', clean: true }
    },
  })
  assert.equal(result.malwareScan.clean, true)
})

test('ClamAV verdict parsing fails closed for detections and malformed responses', () => {
  assert.equal(interpretClamAvResponse('stream: OK\0').clean, true)
  assert.deepEqual(interpretClamAvResponse('stream: Eicar-Signature FOUND'), {
    clean: false,
    threat: 'Eicar-Signature',
    response: 'stream: Eicar-Signature FOUND',
  })
  assert.throws(
    () => interpretClamAvResponse('unexpected'),
    (error) => error instanceof UploadValidationError && error.code === 'UPLOAD_MALWARE_SCAN_INVALID_RESPONSE',
  )
})
