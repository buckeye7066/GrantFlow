import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import JSZip from 'jszip'

import { extractTextWithFallback } from '../../backend/services/documentIngestion/extractTextWithFallback.js'
import { scoreExtraction } from '../../backend/services/documentIngestion/scoreExtraction.js'
import { __setOcrProviderForTests } from '../../backend/services/documentIngestion/ocr/index.js'

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'grantflow-test-'))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeFile(dir, name, buf) {
  const p = path.join(dir, name)
  await fsp.writeFile(p, buf)
  return p
}

async function createMinimalDocxBuffer(text) {
  // Minimal docx: a zip with word/document.xml + required relationship files.
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  )
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  zip.folder('word')?.folder('_rels')?.file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  )
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('docx extraction returns non-empty text', async () => {
  await withTempDir(async (dir) => {
    __setOcrProviderForTests(null)
    const buf = await createMinimalDocxBuffer('Hello from DOCX')
    const filePath = await writeFile(dir, 'test.docx', buf)
    const out = await extractTextWithFallback({ filePath, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    assert.ok(out.text.includes('Hello from DOCX'))
    assert.equal(out.meta.source_type, 'docx')
    assert.ok(out.confidence >= 0.5)
  })
})

test('text-based PDF does not OCR when above thresholds', async () => {
  await withTempDir(async (dir) => {
    // Mock OCR provider, but it should not be called.
    let ocrCalls = 0
    __setOcrProviderForTests({
      id: 'mock',
      recognize: async () => {
        ocrCalls += 1
        return { text: 'SHOULD_NOT_RUN', confidence: 1 }
      },
    })

    const filePath = await writeFile(dir, 'text.pdf', Buffer.from('%PDF-FAKE%'))
    const longText = 'x'.repeat(2000)
    const out = await extractTextWithFallback({
      filePath,
      mimeType: 'application/pdf',
      baseExtractFn: async () => ({
        text: longText,
        meta: {
          source_type: 'pdf',
          methods_used: ['pdf_text'],
          pages: 2,
          char_count: longText.length,
          word_count: 200,
          avg_chars_per_page: longText.length / 2,
          warnings: [],
        },
      }),
    })
    assert.ok(out.meta.methods_used.includes('pdf_text'))
    assert.ok(!out.meta.methods_used.includes('ocr'))
    assert.equal(ocrCalls, 0)
  })
})

test('scanned PDF triggers OCR fallback (mocked rasterizer + provider)', async () => {
  await withTempDir(async (dir) => {
    __setOcrProviderForTests({
      id: 'mock',
      recognize: async () => ({ text: 'OCR PAGE TEXT', confidence: 0.9, warnings: [] }),
    })

    const pdfPath = await writeFile(dir, 'scanned.pdf', Buffer.from('%PDF-FAKE%'))

    // Stub rasterizer so we don't require external pdftoppm in unit tests.
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG signature only
    const imgPath = await writeFile(dir, 'page-1.png', fakePng)

    const out = await extractTextWithFallback({
      filePath: pdfPath,
      mimeType: 'application/pdf',
      baseExtractFn: async () => ({
        text: '',
        meta: {
          source_type: 'pdf',
          methods_used: ['pdf_text'],
          pages: 1,
          char_count: 0,
          word_count: 0,
          avg_chars_per_page: 0,
          warnings: ['PDF text extraction returned little or no selectable text.'],
        },
      }),
      pdfRasterize: async () => ({
        dir,
        files: [imgPath],
        cleanup: async () => {},
      }),
    })

    assert.ok(out.meta.methods_used.includes('ocr'))
    assert.ok(out.text.includes('OCR PAGE TEXT'))
    assert.ok(out.confidence > 0.5)
  })
})

test('png triggers OCR', async () => {
  await withTempDir(async (dir) => {
    __setOcrProviderForTests({
      id: 'mock',
      recognize: async () => ({ text: 'OCR IMAGE TEXT', confidence: 0.8, warnings: [] }),
    })
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const filePath = await writeFile(dir, 'image.png', fakePng)
    const out = await extractTextWithFallback({ filePath, mimeType: 'image/png' })
    assert.ok(out.meta.methods_used.includes('ocr'))
    assert.ok(out.text.includes('OCR IMAGE TEXT'))
  })
})

test('confidence scoring behaves as expected', () => {
  const high = scoreExtraction({
    methods_used: ['pdf_text'],
    pages: 2,
    char_count: 5000,
    avg_chars_per_page: 2500,
    ocr_used: false,
    warnings: [],
    text: 'x'.repeat(5000),
  })
  const low = scoreExtraction({
    methods_used: ['ocr'],
    pages: 2,
    char_count: 200,
    avg_chars_per_page: 100,
    ocr_used: true,
    ocr_confidence: 0.3,
    warnings: ['OCR completed, but no text was detected.'],
    text: 'x'.repeat(200),
  })
  assert.ok(high > low)
  assert.ok(high >= 0.7)
  assert.ok(low <= 0.7)
})

