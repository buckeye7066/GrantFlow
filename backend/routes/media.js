/**
 * media.js — GET /api/media/:id
 *
 * Streams a durable opaque media blob (media_assets.bytes) with full HTTP Range
 * support (Accept-Ranges / 206 partial / Content-Range) so a browser <video>
 * can seek. Content-Type comes from the stored mime_type; the response is
 * marked immutable + long-lived (opaque ids never change content).
 *
 * INTENTIONALLY PUBLIC (no ensureAuth). A welcome video is not sensitive, and —
 * more importantly — a <video src> tag cannot attach the localStorage bearer
 * token, so requiring auth here would break playback entirely. Access is by
 * opaque random id only. This is a deliberate, documented choice.
 */
import { Router } from 'express'

const router = Router()

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0)
  if (Buffer.isBuffer(bytes)) return bytes
  // pg BYTEA / sqlite BLOB both come back as Buffer; be tolerant of anything else.
  try {
    return Buffer.from(bytes)
  } catch {
    return Buffer.alloc(0)
  }
}

// GET /api/media/:id
router.get('/:id', async (req, res) => {
  try {
    const asset = await req.db
      .prepare('SELECT id, mime_type, bytes, size_bytes FROM media_assets WHERE id = ?')
      .get(req.params.id)

    if (!asset) {
      return res.status(404).json({ error: 'media_not_found' })
    }

    const buf = toBuffer(asset.bytes)
    const total = buf.length
    const mime = String(asset.mime_type || '').trim() || 'application/octet-stream'

    res.setHeader('Content-Type', mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')

    const rangeHeader = req.headers.range
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
      if (!match || (match[1] === '' && match[2] === '')) {
        res.setHeader('Content-Range', `bytes */${total}`)
        return res.status(416).end()
      }

      let start
      let end
      if (match[1] === '') {
        // Suffix range: bytes=-N  → last N bytes.
        const suffixLength = parseInt(match[2], 10)
        start = Math.max(0, total - suffixLength)
        end = total - 1
      } else {
        start = parseInt(match[1], 10)
        end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1)
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`)
        return res.status(416).end()
      }

      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
      res.setHeader('Content-Length', String(end - start + 1))
      return res.end(buf.subarray(start, end + 1))
    }

    res.setHeader('Content-Length', String(total))
    return res.end(buf)
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'media_stream_failed' })
  }
})

export default router
