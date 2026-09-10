import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32 } from 'node:zlib'
import {
  UploadValidationError,
  detectUploadKind,
  interpretClamAvResponse,
  validateUploadBuffer,
  validateUploadBufferSecure,
} from '../../backend/utils/uploadFileValidation.js'

// Independent, stored-entry ZIP fixtures: neither the production reader nor its
// library builds our expected input. Header overrides model hostile metadata
// without allocating or inflating the advertised uncompressed size.
function storedZip(files) {
  const bodies = []
  const directory = []
  let offset = 0
  for (const { name, data = Buffer.alloc(0), size = data.length } of files) {
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 28)
    central.writeUInt32LE(offset, 42)
    bodies.push(local, nameBytes, data)
    directory.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralDirectory = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...bodies, centralDirectory, end])
}

function docxEntries() {
  return [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
  ]
}

function minimalDocx() {
  return storedZip(docxEntries())
}

function withMisleadingEndComment(archive, advertisedCount) {
  const bytes = Buffer.from(archive)
  const end = bytes.length - 22
  const comment = Buffer.alloc(23)
  bytes.copy(comment, 0, end)
  comment.writeUInt16LE(advertisedCount, 8)
  comment.writeUInt16LE(advertisedCount, 10)
  comment.writeUInt16LE(0, 20)
  bytes.writeUInt16LE(comment.length, end + 20)
  return Buffer.concat([bytes, comment])
}

function withZip64Directory(archive) {
  const endOffset = archive.length - 22
  const end = Buffer.from(archive.subarray(endOffset))
  const zip64 = Buffer.alloc(56)
  zip64.writeUInt32LE(0x06064b50, 0)
  zip64.writeBigUInt64LE(44n, 4)
  zip64.writeUInt16LE(45, 12)
  zip64.writeUInt16LE(45, 14)
  zip64.writeBigUInt64LE(BigInt(end.readUInt16LE(8)), 24)
  zip64.writeBigUInt64LE(BigInt(end.readUInt16LE(10)), 32)
  zip64.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40)
  zip64.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(endOffset), 8)
  locator.writeUInt32LE(1, 16)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([archive.subarray(0, endOffset), zip64, locator, end])
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

test('DOCX inspection rejects Windows drive paths as well as traversal and absolute paths', () => {
  for (const name of ['C:/secret.xml', 'C:secret.xml', '../secret.xml', 'word/../secret.xml', '/secret.xml', '\\\\host\\share\\secret.xml', 'word\\..\\secret.xml', 'word/secret\u0000.xml']) {
    const archive = storedZip([...docxEntries(), { name }])
    assert.notEqual(detectUploadKind(archive), 'docx', `unsafe archive member: ${JSON.stringify(name)}`)
  }
})

test('DOCX inspection requires both document entries and an intact central directory', () => {
  assert.notEqual(detectUploadKind(storedZip(docxEntries().slice(0, 1))), 'docx')
  assert.notEqual(detectUploadKind(storedZip(docxEntries().slice(1))), 'docx')
  const valid = minimalDocx()
  assert.notEqual(detectUploadKind(valid.subarray(0, valid.length - 22)), 'docx')
  assert.equal(detectUploadKind(storedZip([...docxEntries(), { name: 'word/media/résumé.png', data: Buffer.from([0, 1, 255]) }])), 'docx')
})

test('DOCX inspection rejects corrupt central headers instead of trusting embedded filenames', () => {
  const archive = minimalDocx()
  const central = archive.readUInt32LE(archive.length - 6)
  archive.writeUInt32LE(0x04034b50, central)
  assert.notEqual(detectUploadKind(archive), 'docx')
})

test('DOCX inspection retains support for a ZIP64 central directory', () => {
  assert.equal(detectUploadKind(withZip64Directory(minimalDocx())), 'docx')
})

test('DOCX comments cannot hide unsafe paths or oversized entries behind a second directory footer', () => {
  for (const member of [{ name: '../secret.xml' }, { name: 'word/large.bin', size: 250 * 1024 * 1024 }]) {
    const archive = storedZip([...docxEntries(), member])
    assert.notEqual(detectUploadKind(archive), 'docx')
    assert.notEqual(detectUploadKind(withMisleadingEndComment(archive, 2)), 'docx')
  }
})

test('valid DOCX comments containing directory footer bytes do not change the member list', () => {
  assert.equal(detectUploadKind(withMisleadingEndComment(minimalDocx(), 0)), 'docx')
  assert.equal(detectUploadKind(withMisleadingEndComment(withZip64Directory(minimalDocx()), 0)), 'docx')
})

test('DOCX inspection bounds the entry count, including empty members', () => {
  const files = [...docxEntries(), ...Array.from({ length: 9998 }, (_, i) => ({ name: `word/empty-${i}` }))]
  assert.equal(detectUploadKind(storedZip(files)), 'docx')
  assert.notEqual(detectUploadKind(storedZip([...files, { name: 'word/one-too-many' }])), 'docx')
})

test('DOCX inspection rejects aggregate advertised expansion over 250 MiB before inflation', () => {
  const files = docxEntries()
  const remaining = 250 * 1024 * 1024 - 21 // 8 + 13 bytes in the two XML fixtures
  assert.equal(detectUploadKind(storedZip([...files, { name: 'word/media/large.bin', size: remaining }])), 'docx')
  assert.notEqual(detectUploadKind(storedZip([...files, { name: 'word/media/large.bin', size: remaining + 1 }])), 'docx')
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
