import { promises as fsp } from 'node:fs'

function requireEnv(name) {
  const v = String(process.env[name] || '').trim()
  if (!v) throw new Error(`AWS Textract requires ${name}`)
  return v
}

export function createAwsTextractProvider() {
  const provider = {
    id: 'aws_textract',

    async recognize({ filePath, mime } = {}) {
      if (!filePath) return { text: '', perPage: null, confidence: null, warnings: ['Missing filePath'] }

      // We intentionally load the SDK lazily to keep cold-start costs low when not in use.
      const { TextractClient, DetectDocumentTextCommand } = await import('@aws-sdk/client-textract')

      const region = String(process.env.AWS_REGION || '').trim() || requireEnv('AWS_DEFAULT_REGION')
      const client = new TextractClient({
        region,
        credentials: process.env.AWS_ACCESS_KEY_ID
          ? {
              accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
              secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
              sessionToken: String(process.env.AWS_SESSION_TOKEN || '').trim() || undefined,
            }
          : undefined,
      })

      // Textract DetectDocumentText supports image formats (PNG/JPEG). For PDFs, callers should rasterize pages first.
      if (mime && String(mime).toLowerCase().includes('pdf')) {
        return {
          text: '',
          perPage: null,
          confidence: null,
          warnings: ['aws_textract provider expects rasterized page images for PDFs'],
        }
      }

      const bytes = await fsp.readFile(filePath)
      const resp = await client.send(
        new DetectDocumentTextCommand({
          Document: { Bytes: bytes },
        }),
      )

      const blocks = Array.isArray(resp?.Blocks) ? resp.Blocks : []
      const lines = blocks.filter((b) => b?.BlockType === 'LINE' && typeof b?.Text === 'string')
      const text = lines.map((l) => l.Text).join('\n').trim()

      // Rough confidence heuristic: average LINE confidence if provided.
      const confs = lines
        .map((l) => (typeof l?.Confidence === 'number' && Number.isFinite(l.Confidence) ? l.Confidence : null))
        .filter((v) => v != null)
      const avgConf =
        confs.length > 0 ? Math.max(0, Math.min(1, confs.reduce((a, b) => a + b, 0) / confs.length / 100)) : null

      return { text, perPage: null, confidence: avgConf, warnings: [] }
    },
  }

  return provider
}

