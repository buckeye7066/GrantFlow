/**
 * promoScheduler.js — the ticking heart of Promotion Campaigns.
 *
 * Every PROMO_TICK_MINUTES (default 5) it walks the enabled channels: a
 * channel that is checked in the UI, has its platform credentials configured,
 * and is past its cadence (+ jitter so posts don't land at robotic intervals)
 * gets ONE post — the enabled app with the fewest recent posts on that
 * platform, fresh angle-rotated copy, and the app's uploaded video attached
 * when the platform supports media. Every attempt (posted/failed/skipped)
 * lands in promo_posts so the UI's log is the whole truth.
 *
 * Gates:
 *   PROMO_ENABLED           master switch (default true — channels are all
 *                           unchecked until the owner ticks them, so nothing
 *                           posts out of the box)
 *   PROMO_TICK_MINUTES      loop cadence (default 5)
 *   PROMO_DAILY_CAP         hard per-channel ceiling per 24h (default 8) —
 *                           the backstop against a misconfigured cadence
 *   PROMO_PUBLIC_BASE_URL   public URL that serves /api/promo/assets/:id/raw
 *                           so platforms can fetch videos (defaults to the
 *                           prod API host)
 */

import { createLogger } from '../../utils/logger.js'
import {
  ensurePromoSchema, seedDefaults, listChannels, markChannelPosted,
  recordPost, countPostsSince, pickNextApp, listAssets,
} from './promoStore.js'
import { PLATFORMS, getPlatform } from './promoConnectors.js'
import { generatePromoCopy } from './promoContent.js'

const log = createLogger('promoScheduler')

export function isPromoEnabled() {
  return String(process.env.PROMO_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function tickMinutes() {
  const n = Number.parseInt(process.env.PROMO_TICK_MINUTES || '5', 10)
  return Number.isFinite(n) && n >= 1 ? n : 5
}

function dailyCap() {
  const n = Number.parseInt(process.env.PROMO_DAILY_CAP || '8', 10)
  return Number.isFinite(n) && n >= 1 ? n : 8
}

export function publicBaseUrl() {
  return (process.env.PROMO_PUBLIC_BASE_URL || process.env.PUBLIC_API_URL || 'https://grantflow-production.up.railway.app').replace(/\/+$/, '')
}

// Deterministic per-channel jitter so a 3h cadence lands at 3h ± up to 20%,
// derived from the last-posted timestamp (stable between ticks, no Math.random
// per tick — keeps "due" decisions consistent).
function jitterFactor(platformKey, lastIso) {
  const seed = `${platformKey}:${lastIso || ''}`
  let h = 0
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return 1 + ((h % 41) - 20) / 100 // 0.80 .. 1.20
}

export function isChannelDue(channel, now = Date.now()) {
  if (!channel?.enabled) return false
  if (!channel.last_posted_at) return true
  const last = new Date(channel.last_posted_at).getTime()
  if (Number.isNaN(last)) return true
  const cadenceMs = Math.max(30, Number(channel.cadence_minutes) || 240) * 60_000
  return now - last >= cadenceMs * jitterFactor(channel.platform, channel.last_posted_at)
}

/**
 * Post once to one channel (used by the scheduler AND the UI's "Post now").
 * Never throws — returns the recorded outcome.
 */
export async function postOnce(db, { platformKey, appId = null, force = false } = {}) {
  const platform = getPlatform(platformKey)
  if (!platform) return { status: 'skipped', reason: 'unknown_platform' }
  if (!platform.isConfigured()) return { status: 'skipped', reason: 'not_configured', required_env: platform.requiredEnv }

  // Hard daily ceiling — even a bad cadence value can't spam a platform.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const postedToday = await countPostsSince(db, platformKey, since)
  if (!force && postedToday >= dailyCap()) return { status: 'skipped', reason: 'daily_cap_reached', posted_today: postedToday }

  const app = appId
    ? await db.prepare('SELECT * FROM promo_apps WHERE id = ?').get(appId)
    : await pickNextApp(db, platformKey)
  if (!app || !app.enabled) return { status: 'skipped', reason: 'no_enabled_app' }
  if (!app.url) return { status: 'skipped', reason: 'app_missing_url', app_id: app.id }

  // Angle rotation: lifetime post count for this app+platform picks the angle.
  let sequence = 0
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM promo_posts WHERE platform = ? AND app_id = ?').get(platformKey, app.id)
    sequence = Number(row?.n || 0)
  } catch { sequence = 0 }

  const { text } = await generatePromoCopy(app, platform, { sequence })

  // Attach the app's newest video where the platform can take one. Served
  // from the public asset route (platforms fetch media by URL).
  let mediaUrl = null
  let mediaMime = null
  let mediaAssetId = null
  if (platform.supportsVideo) {
    try {
      const assets = await listAssets(db, app.id)
      const video = assets.find((a) => /video/.test(a.mime_type || '') || a.kind === 'video')
      if (video) {
        mediaAssetId = video.id
        mediaMime = video.mime_type || 'video/mp4'
        mediaUrl = `${publicBaseUrl()}/api/promo/assets/${video.id}/raw`
      }
    } catch { /* media is optional */ }
  }

  try {
    const result = await platform.post({
      text,
      link: app.url,
      linkTitle: `${app.name} — ${app.tagline || ''}`.trim(),
      title: `${app.name}: ${app.tagline || app.url}`,
      mediaUrl,
      mediaMime,
    })
    await recordPost(db, {
      appId: app.id, platform: platformKey, content: text, mediaAssetId,
      status: 'posted', externalId: result?.external_id || null, externalUrl: result?.external_url || null,
    })
    await markChannelPosted(db, platformKey)
    log.info('promo posted', { platform: platformKey, app: app.id })
    return { status: 'posted', app_id: app.id, platform: platformKey, external_url: result?.external_url || null }
  } catch (err) {
    await recordPost(db, {
      appId: app.id, platform: platformKey, content: text, mediaAssetId,
      status: 'failed', error: String(err?.message || err).slice(0, 800),
    })
    // Still advance last_posted_at so a hard-failing channel retries on its
    // cadence instead of hammering every tick.
    await markChannelPosted(db, platformKey)
    log.warn('promo post failed', { platform: platformKey, app: app.id, error: err?.message })
    return { status: 'failed', app_id: app.id, platform: platformKey, error: err?.message }
  }
}

export async function runPromoTick(db) {
  if (!isPromoEnabled()) return { ran: false, reason: 'disabled' }
  await ensurePromoSchema(db)
  const channels = await listChannels(db)
  const results = []
  for (const ch of channels) {
    if (!isChannelDue(ch)) continue
    results.push(await postOnce(db, { platformKey: ch.platform }))
  }
  return { ran: true, attempted: results.length, results }
}

let timer = null
export function startPromoScheduler({ db }) {
  if (!isPromoEnabled()) {
    log.info('promo scheduler disabled (PROMO_ENABLED=false)')
    return { started: false, reason: 'disabled' }
  }
  // Seed apps + channel rows so the UI has something to show immediately.
  seedDefaults(db, PLATFORMS).catch((err) => log.warn('promo seed failed', { error: err?.message }))
  const everyMs = tickMinutes() * 60_000
  timer = setInterval(() => {
    runPromoTick(db).catch((err) => log.warn('promo tick failed', { error: err?.message }))
  }, everyMs)
  if (timer.unref) timer.unref()
  log.info(`promo scheduler started (tick every ${tickMinutes()}m, daily cap ${dailyCap()}/channel)`)
  return { started: true, tick_minutes: tickMinutes() }
}

export function stopPromoScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

export default { startPromoScheduler, stopPromoScheduler, runPromoTick, postOnce, isChannelDue, isPromoEnabled, publicBaseUrl }
