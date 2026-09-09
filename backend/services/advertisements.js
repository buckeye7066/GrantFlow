import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { getAuthUserId } from '../utils/accessControl.js'

export const MAX_AD_IMAGE_BYTES = 512 * 1024
export const MAX_AD_CREATIVES = 40

// Pin a previously verified immutable account ID in private deployment config.
// A name, email, token role, generic admin, or service token is never ownership.
export async function isAdvertisingOwner(db, user, ownerId = process.env.ADVERTISING_OWNER_USER_ID) {
  const id = getAuthUserId(user)
  if (!ownerId || !id || String(id) !== ownerId || user?.serviceToken || user?.profileTokenAuth) return false
  const row = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(String(id))
  return row?.is_admin === true || row?.is_admin === 1
}

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  throw error
}

function plainText(value, label, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (/[<>]/u.test(value) || Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))))) invalid(`${label} must be plain text (maximum ${maximum} characters).`)
  if (required && !value.trim()) invalid(`${label} is required.`)
  return value.trim()
}

export function validateAdvertisement(input) {
  if (!input || typeof input !== 'object') invalid('Advertisement fields are required.')
  const advertiser = plainText(input.advertiser, 'Advertiser', 100)
  const headline = plainText(input.headline, 'Headline', 160)
  const body = plainText(input.body ?? '', 'Body', 600, false)
  let url
  try { url = new URL(input.target_url) } catch { invalid('Enter a public HTTPS destination.') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.port || host === 'localhost' || !host.includes('.') || /^(?:\d|\[)/u.test(host) || /\.(?:localhost|local|internal|invalid|test)$/u.test(host) || url.href.length > 2000) invalid('Enter a public HTTPS destination without credentials.')
  const seconds = Number(input.duration_seconds)
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) invalid('Slide duration must be 5 to 300 seconds.')
  const start = Date.parse(input.starts_at)
  const end = Date.parse(input.ends_at)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400000) invalid('Choose valid start and end dates, up to one year apart.')
  if (!['published', 'paused'].includes(input.status)) invalid('Choose published or paused.')
  return { advertiser, headline, body, target_url: url.href, duration_seconds: seconds, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), status: input.status }
}

export function validateAdImage(file) {
  const bytes = file?.buffer
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_AD_IMAGE_BYTES) invalid('Each image must be a PNG, JPEG, or WebP up to 512 KB.')
  let mime
  let width = 0
  let height = 0
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mime = 'image/jpeg'
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if ([192, 193, 194].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break }
      if (length < 2) break
      offset += 2 + length
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.length >= 30) {
    mime = 'image/webp'
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') { if (bytes[20] & 2) invalid('Animated images are not supported.'); width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3) }
    if (kind === 'VP8 ') { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383 }
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1 }
  }
  if (!mime || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8000000) invalid('Use a valid raster image up to 4096 pixels per side and 8 megapixels.')
  return { image_mime: mime, image_base64: bytes.toString('base64'), image_hash: createHash('sha256').update(bytes).digest('hex') }
}

export const ADVERTISEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS advertisements (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, advertiser TEXT NOT NULL,
  headline TEXT NOT NULL, body TEXT NOT NULL, target_url TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 5 AND 300),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published', 'paused', 'removed')),
  image_mime TEXT NOT NULL, image_base64 TEXT NOT NULL, image_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS advertisement_events (
  ad_id TEXT NOT NULL REFERENCES advertisements(id), viewer_hash TEXT NOT NULL,
  day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('impression', 'click')),
  bucket TEXT NOT NULL, created_at TEXT NOT NULL, ticket_hash TEXT NOT NULL,
  UNIQUE(ticket_hash, kind),
  PRIMARY KEY(ad_id, viewer_hash, day, kind, bucket)
);
CREATE TABLE IF NOT EXISTS advertisement_view_tickets (
  ticket_hash TEXT PRIMARY KEY, ad_id TEXT NOT NULL REFERENCES advertisements(id),
  viewer_hash TEXT NOT NULL, issued_ms TEXT NOT NULL, expires_ms TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS advertisement_events_daily ON advertisement_events(ad_id, day, kind);
`

export function isActiveAdvertisement(ad, now = Date.now()) {
  return ad?.status === 'published' && Date.parse(ad.starts_at) <= now && Date.parse(ad.ends_at) > now
}

export async function createAdvertisements(db, input, files) {
  const fields = validateAdvertisement(input)
  if (!Array.isArray(files) || files.length < 1 || files.length > 8) invalid('Upload between one and eight distinct images.')
  const images = files.map(validateAdImage)
  if (new Set(images.map(image => image.image_hash)).size !== images.length) invalid('Choose distinct images for each creative.')
  const current = await db.prepare("SELECT COUNT(*) AS count FROM advertisements WHERE status <> 'removed'").get()
  if (Number(current.count) + images.length > MAX_AD_CREATIVES) invalid('Remove an existing advertisement before adding more (40 creative limit).')
  const now = new Date().toISOString()
  const campaign = randomUUID()
  const ids = images.map(() => randomUUID())
  const args = images.flatMap((image, index) => [ids[index], campaign, fields.advertiser, fields.headline, fields.body, fields.target_url, fields.duration_seconds, fields.starts_at, fields.ends_at, fields.status, image.image_mime, image.image_base64, image.image_hash, now, now])
  const placeholders = images.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  // audit:allow dynamic-sql -- placeholders contain only fixed bind markers, never input.
  await db.prepare(`INSERT INTO advertisements (id, campaign_id, advertiser, headline, body, target_url, duration_seconds, starts_at, ends_at, status, image_mime, image_base64, image_hash, created_at, updated_at) VALUES ${placeholders}`).run(...args)
  return ids
}

const viewerHash = userId => createHash('sha256').update(`grantflow-ad-viewer:${userId}`).digest('hex')
const ticketHash = ticket => createHash('sha256').update(ticket).digest('hex')

export async function issueAdvertisementTicket(db, adId, userId, now = Date.now()) {
  const ad = await db.prepare('SELECT status, starts_at, ends_at FROM advertisements WHERE id = ?').get(adId)
  if (!isActiveAdvertisement(ad, now)) return null
  const ticket = randomBytes(32).toString('hex')
  await db.prepare('INSERT INTO advertisement_view_tickets (ticket_hash, ad_id, viewer_hash, issued_ms, expires_ms) VALUES (?, ?, ?, ?, ?)').run(ticketHash(ticket), adId, viewerHash(userId), String(now), String(now + 120000))
  await db.prepare('DELETE FROM advertisement_view_tickets WHERE expires_ms < ?').run(String(now - 86400000))
  return ticket
}

export async function recordAdvertisementEvent(db, adId, userId, kind, ticket, now = Date.now()) {
  if (!['impression', 'click'].includes(kind)) invalid('Unknown advertisement event.')
  if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/u.test(ticket)) return false
  const ad = await db.prepare('SELECT status, starts_at, ends_at FROM advertisements WHERE id = ?').get(adId)
  if (!isActiveAdvertisement(ad, now)) return false
  const day = new Date(now).toISOString().slice(0, 10)
  // Pseudonymous signed-in account counts; no profile fields, IPs, or raw IDs.
  const viewer = viewerHash(userId)
  const hash = ticketHash(ticket)
  if (kind === 'click') {
    const impression = await db.prepare("SELECT ad_id FROM advertisement_events WHERE ticket_hash = ? AND ad_id = ? AND viewer_hash = ? AND kind = 'impression' LIMIT 1").get(hash, adId, viewer)
    if (!impression) return false
  }
  // A cryptographically random, DB-issued display ticket is bound to one account
  // and creative, has a server-measured dwell and expiry, and is consumed once
  // per event kind by UNIQUE(ticket_hash, kind). The bucket dedupes fresh tickets.
  const result = await db.prepare(`INSERT INTO advertisement_events (ad_id, viewer_hash, day, kind, bucket, created_at, ticket_hash)
    SELECT ?, ?, ?, ?, ?, ?, ? FROM advertisement_view_tickets
    WHERE ticket_hash = ? AND ad_id = ? AND viewer_hash = ? AND issued_ms <= ? AND expires_ms > ?
    ON CONFLICT DO NOTHING`).run(adId, viewer, day, kind, String(Math.floor(now / 30000)), new Date(now).toISOString(), hash, hash, adId, viewer, String(now - 1000), String(now))
  return Number(result?.changes ?? result?.rowCount ?? 0) > 0
}
