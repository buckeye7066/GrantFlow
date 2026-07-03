/**
 * routes/promo.js — Promotion Campaigns (owner/admin console).
 *
 * The checkbox-driven cross-app promotion system: pick which platforms to
 * promote on, GrantFlow writes the copy on an aggressive-but-capped cadence,
 * attaches the app's uploaded video where the platform supports media, and
 * logs every post. Apps are extensible ("Add app" in the UI).
 *
 * ALL management endpoints are admin-only. The single exception is
 * GET /assets/:id/raw — platforms (Threads/Telegram/Facebook) fetch media by
 * URL with no auth, so that route serves bytes publicly keyed on an
 * unguessable UUID.
 */

import express from 'express'
import multer from 'multer'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { formatError } from '../middleware/errorHandler.js'
import {
  listApps, upsertApp, deleteApp,
  addAsset, listAssets, getAssetWithBytes, deleteAsset,
  listChannels, setChannel, listRecentPosts, ensurePromoSchema,
  seedDefaults,
} from '../services/promo/promoStore.js'
import { PLATFORMS, platformStatus } from '../services/promo/promoConnectors.js'
import { postOnce, isPromoEnabled, publicBaseUrl } from '../services/promo/promoScheduler.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // videos — 200MB ceiling
})

// ── PUBLIC media route (platforms fetch video/image by URL) ──────────
router.get('/assets/:id/raw', async (req, res) => {
  try {
    const asset = await getAssetWithBytes(req.db, String(req.params.id))
    if (!asset || !asset.bytes) return res.status(404).json({ error: 'not_found' })
    res.setHeader('content-type', asset.mime_type || 'application/octet-stream')
    res.setHeader('content-length', String(asset.file_size || asset.bytes.length))
    res.setHeader('cache-control', 'public, max-age=86400')
    return res.end(Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes))
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

// Everything below is owner/admin-only.
router.use(ensureAuth)
router.use(ensureAdmin)

// One-call overview for the Promotion tab.
router.get('/overview', async (req, res) => {
  try {
    await ensurePromoSchema(req.db)
    await seedDefaults(req.db, PLATFORMS)
    const [apps, channels, posts] = await Promise.all([
      listApps(req.db),
      listChannels(req.db),
      listRecentPosts(req.db, { limit: 50 }),
    ])
    const status = platformStatus()
    const assets = await listAssets(req.db)
    return res.json({
      ok: true,
      enabled: isPromoEnabled(),
      public_base_url: publicBaseUrl(),
      apps: apps.map((a) => ({ ...a, assets: assets.filter((x) => x.app_id === a.id) })),
      channels: channels.map((c) => ({
        ...c,
        ...(status.find((s) => s.key === c.platform) || {}),
      })),
      recent_posts: posts,
    })
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

// Apps (extensible — "Add more apps later" is this endpoint).
router.post('/apps', async (req, res) => {
  try {
    const app = await upsertApp(req.db, {
      id: req.body?.id || null,
      name: req.body?.name,
      tagline: req.body?.tagline,
      url: req.body?.url,
      description: req.body?.description,
      audience: req.body?.audience,
      hashtags: req.body?.hashtags,
      enabled: req.body?.enabled === undefined ? 1 : (req.body.enabled ? 1 : 0),
    })
    return res.json({ ok: true, app })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

router.delete('/apps/:id', async (req, res) => {
  try {
    await deleteApp(req.db, String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

// Media assets (the owner's promo videos).
router.post('/apps/:id/assets', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'file required' })
    const asset = await addAsset(req.db, {
      appId: String(req.params.id),
      kind: /video/.test(req.file.mimetype || '') ? 'video' : 'image',
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      bytes: req.file.buffer,
    })
    return res.json({ ok: true, asset })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

router.delete('/assets/:id', async (req, res) => {
  try {
    await deleteAsset(req.db, String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

// Channel checkboxes + cadence.
router.post('/channels/:platform', async (req, res) => {
  try {
    const channel = await setChannel(req.db, String(req.params.platform), {
      enabled: req.body?.enabled,
      cadenceMinutes: req.body?.cadence_minutes,
    })
    return res.json({ ok: true, channel })
  } catch (error) {
    return res.status(400).json(formatError(error))
  }
})

// "Post now" — immediate single post (also how you test a new channel).
router.post('/post-now', async (req, res) => {
  try {
    const result = await postOnce(req.db, {
      platformKey: String(req.body?.platform || ''),
      appId: req.body?.app_id || null,
      force: req.body?.force === true,
    })
    return res.json({ ok: result.status === 'posted', ...result })
  } catch (error) {
    return res.status(500).json(formatError(error))
  }
})

export default router
