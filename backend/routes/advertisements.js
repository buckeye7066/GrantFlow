import express from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { ensureAuth } from '../middleware/auth.js'
import { getAuthUserId } from '../utils/accessControl.js'
import { createAdvertisements, hasViewedAdvertisementTicket, issueAdvertisementTicket, isActiveAdvertisement, isAdvertisingOwner, MAX_AD_IMAGE_BYTES, recordAdvertisementEvent, validateAdvertisement, validateAdImage } from '../services/advertisements.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AD_IMAGE_BYTES, files: 8, fields: 10, fieldSize: 3000 } })
const eventsLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false })

router.use(ensureAuth)
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

async function ownerOnly(req, res, next) {
  if (!await isAdvertisingOwner(req.db, req.user)) return res.status(403).json({ error: 'Only the application owner can manage advertisements.' })
  return next()
}

router.get('/', async (req, res) => {
  const now = new Date().toISOString()
  const advertisements = await req.db.prepare("SELECT id, advertiser, headline, body, target_url, duration_seconds, starts_at, ends_at, updated_at FROM advertisements WHERE status = 'published' AND starts_at <= ? AND ends_at > ? ORDER BY created_at, id LIMIT 40").all(now, now)
  res.json({ advertisements, canManage: await isAdvertisingOwner(req.db, req.user), serverTime: now })
})

router.get('/manage', ownerOnly, async (req, res) => {
  const advertisements = await req.db.prepare("SELECT id, campaign_id, advertiser, headline, body, target_url, duration_seconds, starts_at, ends_at, status, created_at, updated_at FROM advertisements WHERE status <> 'removed' ORDER BY created_at DESC LIMIT 40").all()
  const totals = await req.db.prepare("SELECT ad_id, SUM(CASE WHEN kind = 'impression' THEN 1 ELSE 0 END) AS impressions, SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks, COUNT(DISTINCT CASE WHEN kind = 'impression' THEN viewer_hash END) AS unique_viewers FROM advertisement_events GROUP BY ad_id").all()
  const daily = await req.db.prepare("SELECT ad_id, day, SUM(CASE WHEN kind = 'impression' THEN 1 ELSE 0 END) AS impressions, SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks, COUNT(DISTINCT CASE WHEN kind = 'impression' THEN viewer_hash END) AS unique_viewers FROM advertisement_events GROUP BY ad_id, day ORDER BY day DESC LIMIT 15000").all()
  res.json({ advertisements, totals, daily })
})

router.post('/manage', ownerOnly, upload.array('images', 8), async (req, res) => {
  const ids = await createAdvertisements(req.db, req.body, req.files)
  res.status(201).json({ ids })
})

router.put('/manage/:id', ownerOnly, upload.single('images'), async (req, res) => {
  const exists = await req.db.prepare("SELECT id FROM advertisements WHERE id = ? AND status <> 'removed'").get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Advertisement not found.' })
  const fields = validateAdvertisement(req.body)
  const image = req.file ? validateAdImage(req.file) : null
  await req.db.prepare("UPDATE advertisements SET advertiser = ?, headline = ?, body = ?, target_url = ?, duration_seconds = ?, starts_at = ?, ends_at = ?, status = ?, updated_at = ?, image_mime = COALESCE(?, image_mime), image_base64 = COALESCE(?, image_base64), image_hash = COALESCE(?, image_hash) WHERE id = ? AND status <> 'removed'").run(fields.advertiser, fields.headline, fields.body, fields.target_url, fields.duration_seconds, fields.starts_at, fields.ends_at, fields.status, new Date().toISOString(), image?.image_mime ?? null, image?.image_base64 ?? null, image?.image_hash ?? null, req.params.id)
  res.json({ ok: true })
})

router.delete('/manage/:id', ownerOnly, async (req, res) => {
  // Retain the row identity and real historical aggregate metrics, remove media.
  await req.db.prepare("UPDATE advertisements SET status = 'removed', image_base64 = '', updated_at = ? WHERE id = ?").run(new Date().toISOString(), req.params.id)
  res.json({ ok: true })
})

router.get('/:id/image', async (req, res) => {
  const ad = await req.db.prepare('SELECT status, starts_at, ends_at, image_mime, image_base64 FROM advertisements WHERE id = ?').get(req.params.id)
  if (!ad || ad.status === 'removed' || (!isActiveAdvertisement(ad) && !await isAdvertisingOwner(req.db, req.user))) return res.status(404).json({ error: 'Advertisement not found.' })
  res.set('X-Content-Type-Options', 'nosniff').type(ad.image_mime).send(Buffer.from(ad.image_base64, 'base64'))
})

router.post('/:id/view-ticket', eventsLimit, async (req, res) => {
  if (await isAdvertisingOwner(req.db, req.user)) return res.json({ ticket: null })
  const ticket = await issueAdvertisementTicket(req.db, req.params.id, getAuthUserId(req.user))
  res.json({ ticket })
})

router.post('/:id/events', eventsLimit, async (req, res) => {
  if (await isAdvertisingOwner(req.db, req.user)) return res.json({ counted: false })
  const counted = await recordAdvertisementEvent(req.db, req.params.id, getAuthUserId(req.user), req.body?.kind, req.body?.ticket)
  const accepted = await hasViewedAdvertisementTicket(req.db, req.params.id, getAuthUserId(req.user), req.body?.ticket)
  res.json({ counted, accepted })
})

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Upload at most eight PNG, JPEG, or WebP images, each up to 512 KB.' })
  if (error.status === 400) return res.status(400).json({ error: error.message })
  return next(error)
})

export default router
