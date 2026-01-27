#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { extractTextWithFallback } from '../backend/services/documentIngestion/extractTextWithFallback.js'
import { detectFileType } from '../backend/services/documentIngestion/detectFileType.js'

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: node scripts/ingest-doc.js path/to/file.pdf')
    process.exitCode = 1
    return
  }

  const filePath = path.resolve(process.cwd(), input)
  const detected = detectFileType({ filePath, fileName: path.basename(filePath) })

  const out = await extractTextWithFallback({
    filePath,
    mimeType: detected.mime,
    fileName: path.basename(filePath),
  })

  const methods = Array.isArray(out.meta?.methods_used) ? out.meta.methods_used.join(',') : ''
  const pages = out.meta?.pages ?? null
  const words = out.meta?.word_count ?? 0
  const confidence = typeof out.confidence === 'number' ? out.confidence : 0

  console.log('=== Document ingestion ===')
  console.log('file:', filePath)
  console.log('source_type:', out.meta?.source_type ?? detected.source_type ?? 'unknown')
  console.log('methods_used:', methods || 'none')
  console.log('pages:', pages == null ? 'n/a' : pages)
  console.log('words:', words)
  console.log('chars:', out.meta?.char_count ?? 0)
  console.log('ocr_used:', Boolean(out.meta?.ocr_used))
  console.log('confidence:', confidence.toFixed(2))
  if (Array.isArray(out.meta?.warnings) && out.meta.warnings.length) {
    console.log('warnings:', out.meta.warnings.join(' | '))
  }
  console.log('\n--- text preview (first 500 chars) ---\n')
  console.log(String(out.text || '').slice(0, 500))
  console.log('\n--- end preview ---')
}

main().catch((err) => {
  console.error('[ingest-doc] failed:', err?.message || err)
  process.exitCode = 1
})

