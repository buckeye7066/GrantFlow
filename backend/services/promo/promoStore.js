/**
 * promoStore.js — persistence for the owner's cross-app Promotion Campaigns.
 *
 * Owner spec (2026-07-03): an automated system that promotes GrantFlow,
 * GeneMap, and SermonSmith anywhere outside app stores, driven by checkboxes —
 * check "Threads" and posts go out often enough to garner attention; promo
 * copy is written automatically; the owner's uploaded videos ride along where
 * a platform supports media; and new apps can join later.
 *
 * Tables (self-healed on first use, both dialects):
 *   promo_apps      — one row per product being promoted (extensible)
 *   promo_assets    — uploaded media (video/image) stored as BYTES in the DB
 *                     (Railway's disk is ephemeral — same rule as documents)
 *   promo_channels  — one row per platform with the checkbox + cadence
 *   promo_posts     — full audit log of every post attempt
 */

import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('promoStore')

let schemaEnsured = false
export function _resetPromoSchemaCache() { schemaEnsured = false }

export async function ensurePromoSchema(db) {
  if (schemaEnsured) return
  const pg = db?.dialect === 'postgres'
  const BYTES = pg ? 'BYTEA' : 'BLOB'
  const stmts = [
    `CREATE TABLE IF NOT EXISTS promo_apps (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       tagline TEXT,
       url TEXT,
       description TEXT,
       audience TEXT,
       hashtags TEXT,
       enabled INTEGER DEFAULT 1,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS promo_assets (
       id TEXT PRIMARY KEY,
       app_id TEXT NOT NULL,
       kind TEXT DEFAULT 'video',
       file_name TEXT,
       mime_type TEXT,
       file_size INTEGER,
       bytes ${BYTES},
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS promo_channels (
       id TEXT PRIMARY KEY,
       platform TEXT UNIQUE NOT NULL,
       enabled INTEGER DEFAULT 0,
       cadence_minutes INTEGER DEFAULT 240,
       last_posted_at TIMESTAMP,
       config_json TEXT DEFAULT '{}',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS promo_posts (
       id TEXT PRIMARY KEY,
       app_id TEXT,
       platform TEXT,
       content TEXT,
       media_asset_id TEXT,
       status TEXT,
       external_id TEXT,
       external_url TEXT,
       error TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_promo_posts_platform ON promo_posts(platform, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_promo_posts_app ON promo_posts(app_id, created_at)`,
  ]
  for (const s of stmts) await db.exec(s)
  schemaEnsured = true
}

// ── seeds ────────────────────────────────────────────────────────────
// The three launch apps. Names/URLs are real; copy fields are editable in the
// UI. Adding a fourth app later = one INSERT via the "Add app" form.
export const DEFAULT_APPS = [
  {
    id: 'grantflow',
    name: 'GrantFlow',
    tagline: 'Stop hunting for funding. Start receiving it.',
    url: 'https://www.axiombiolabs.org/grantflow',
    description:
      'GrantFlow builds a funding profile of you or your organization, matches it against grants, scholarships, and assistance programs of exactly that kind, and then keeps every deadline, document, and application moving in one place. AI agents draft applications, watch portals, and surface what you almost qualify for.',
    audience: 'nonprofits, students, families, small businesses, and anyone who needs funding',
    hashtags: '#grants #scholarships #funding #nonprofit #fundraising',
  },
  {
    id: 'genemap',
    name: 'GeneMap Discovery',
    tagline: 'Genomic insight without the genomics PhD.',
    url: 'https://genemap-discovery.vercel.app',
    description:
      'GeneMap Discovery turns raw genomic data into clear, navigable maps of genes, variants, and their significance — analysis pipelines, annotations, and reports that researchers and curious minds can actually read.',
    audience: 'researchers, biology students, biotech teams, citizen scientists',
    hashtags: '#genomics #bioinformatics #genetics #research #science',
  },
  {
    id: 'sermonsmith',
    name: 'SermonSmith',
    tagline: 'From scripture to sermon, without losing the Spirit in the busywork.',
    url: 'https://sermonsmith.vercel.app',
    description:
      'SermonSmith is a sermon-preparation workspace for pastors and teachers: organize scripture study, build outlines, keep series on track, and prepare messages across web, desktop, and mobile.',
    audience: 'pastors, ministry leaders, Bible teachers, seminary students',
    hashtags: '#sermon #preaching #ministry #church #biblestudy',
  },
]

export async function seedDefaults(db, platforms) {
  await ensurePromoSchema(db)
  for (const app of DEFAULT_APPS) {
    const existing = await db.prepare('SELECT id FROM promo_apps WHERE id = ?').get(app.id)
    if (!existing) {
      await db.prepare(
        `INSERT INTO promo_apps (id, name, tagline, url, description, audience, hashtags, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(app.id, app.name, app.tagline, app.url, app.description, app.audience, app.hashtags)
    }
  }
  for (const p of platforms) {
    const existing = await db.prepare('SELECT id FROM promo_channels WHERE platform = ?').get(p.key)
    if (!existing) {
      await db.prepare(
        `INSERT INTO promo_channels (id, platform, enabled, cadence_minutes) VALUES (?, ?, 0, ?)`,
      ).run(crypto.randomUUID(), p.key, p.defaultCadenceMinutes)
    }
  }
}

// ── apps ─────────────────────────────────────────────────────────────

export async function listApps(db) {
  await ensurePromoSchema(db)
  return (await db.prepare('SELECT * FROM promo_apps ORDER BY created_at').all()) || []
}

export async function upsertApp(db, { id = null, name, tagline, url, description, audience, hashtags, enabled = 1 }) {
  await ensurePromoSchema(db)
  if (!name || !String(name).trim()) throw new Error('name required')
  const appId = id || String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const existing = await db.prepare('SELECT id FROM promo_apps WHERE id = ?').get(appId)
  if (existing) {
    await db.prepare(
      `UPDATE promo_apps SET name = ?, tagline = ?, url = ?, description = ?, audience = ?, hashtags = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(name, tagline || null, url || null, description || null, audience || null, hashtags || null, enabled ? 1 : 0, appId)
  } else {
    await db.prepare(
      `INSERT INTO promo_apps (id, name, tagline, url, description, audience, hashtags, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(appId, name, tagline || null, url || null, description || null, audience || null, hashtags || null, enabled ? 1 : 0)
  }
  return db.prepare('SELECT * FROM promo_apps WHERE id = ?').get(appId)
}

export async function deleteApp(db, appId) {
  await ensurePromoSchema(db)
  await db.prepare('DELETE FROM promo_assets WHERE app_id = ?').run(appId)
  await db.prepare('DELETE FROM promo_apps WHERE id = ?').run(appId)
}

// ── assets ───────────────────────────────────────────────────────────

export async function addAsset(db, { appId, kind = 'video', fileName, mimeType, bytes }) {
  await ensurePromoSchema(db)
  if (!appId) throw new Error('appId required')
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('bytes required')
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO promo_assets (id, app_id, kind, file_name, mime_type, file_size, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, appId, kind, fileName || null, mimeType || null, bytes.length, bytes)
  return { id, app_id: appId, kind, file_name: fileName, mime_type: mimeType, file_size: bytes.length }
}

export async function listAssets(db, appId = null) {
  await ensurePromoSchema(db)
  if (appId) {
    return (await db.prepare('SELECT id, app_id, kind, file_name, mime_type, file_size, created_at FROM promo_assets WHERE app_id = ? ORDER BY created_at DESC').all(appId)) || []
  }
  return (await db.prepare('SELECT id, app_id, kind, file_name, mime_type, file_size, created_at FROM promo_assets ORDER BY created_at DESC').all()) || []
}

export async function getAssetWithBytes(db, id) {
  await ensurePromoSchema(db)
  return db.prepare('SELECT * FROM promo_assets WHERE id = ?').get(id)
}

export async function deleteAsset(db, id) {
  await ensurePromoSchema(db)
  await db.prepare('DELETE FROM promo_assets WHERE id = ?').run(id)
}

// ── channels ─────────────────────────────────────────────────────────

export async function listChannels(db) {
  await ensurePromoSchema(db)
  return (await db.prepare('SELECT * FROM promo_channels ORDER BY platform').all()) || []
}

export async function setChannel(db, platform, { enabled, cadenceMinutes } = {}) {
  await ensurePromoSchema(db)
  const row = await db.prepare('SELECT * FROM promo_channels WHERE platform = ?').get(platform)
  if (!row) throw new Error(`unknown platform: ${platform}`)
  const nextEnabled = enabled === undefined ? row.enabled : (enabled ? 1 : 0)
  const nextCadence = Number.isFinite(Number(cadenceMinutes)) && Number(cadenceMinutes) >= 30
    ? Math.floor(Number(cadenceMinutes))
    : row.cadence_minutes
  await db.prepare(
    `UPDATE promo_channels SET enabled = ?, cadence_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE platform = ?`,
  ).run(nextEnabled, nextCadence, platform)
  return db.prepare('SELECT * FROM promo_channels WHERE platform = ?').get(platform)
}

export async function markChannelPosted(db, platform, atIso = new Date().toISOString()) {
  await ensurePromoSchema(db)
  await db.prepare('UPDATE promo_channels SET last_posted_at = ? WHERE platform = ?').run(atIso, platform)
}

// ── post log ─────────────────────────────────────────────────────────

export async function recordPost(db, { appId, platform, content, mediaAssetId = null, status, externalId = null, externalUrl = null, error = null }) {
  await ensurePromoSchema(db)
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO promo_posts (id, app_id, platform, content, media_asset_id, status, external_id, external_url, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, appId, platform, content, mediaAssetId, status, externalId, externalUrl, error)
  return id
}

export async function listRecentPosts(db, { limit = 50 } = {}) {
  await ensurePromoSchema(db)
  const lim = Math.max(1, Math.min(500, Number(limit) || 50))
  return (await db.prepare('SELECT * FROM promo_posts ORDER BY created_at DESC LIMIT ?').all(lim)) || []
}

export async function countPostsSince(db, platform, sinceIso) {
  await ensurePromoSchema(db)
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM promo_posts WHERE platform = ? AND status = 'posted' AND created_at >= ?`,
    ).get(platform, sinceIso)
    return Number(row?.n || 0)
  } catch {
    return 0
  }
}

/** Round-robin fairness: the enabled app with the fewest recent posts on this platform goes next. */
export async function pickNextApp(db, platform) {
  await ensurePromoSchema(db)
  const apps = (await db.prepare('SELECT * FROM promo_apps WHERE enabled = 1 ORDER BY created_at').all()) || []
  if (apps.length === 0) return null
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
  let best = null
  let bestCount = Infinity
  for (const app of apps) {
    let n = 0
    try {
      const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM promo_posts WHERE platform = ? AND app_id = ? AND status = 'posted' AND created_at >= ?`,
      ).get(platform, app.id, since)
      n = Number(row?.n || 0)
    } catch { n = 0 }
    if (n < bestCount) { best = app; bestCount = n }
  }
  return best
}

export default {
  ensurePromoSchema, seedDefaults, listApps, upsertApp, deleteApp,
  addAsset, listAssets, getAssetWithBytes, deleteAsset,
  listChannels, setChannel, markChannelPosted,
  recordPost, listRecentPosts, countPostsSince, pickNextApp,
  DEFAULT_APPS,
}

void log
