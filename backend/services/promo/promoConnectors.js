/**
 * promoConnectors.js — one adapter per platform the Promotion Campaigns
 * system can post to. Everything OUTSIDE app stores, per the owner's spec.
 *
 * Every adapter is credential-gated by env vars: a channel whose env isn't
 * set shows "Needs setup" in the UI (with the exact variable names) and the
 * scheduler skips it — checking the box never fakes a post. Each post()
 * returns { external_id, external_url } or throws with an honest error that
 * lands in the promo_posts log.
 *
 * HONESTY + TOS NOTES (owner rule: keep me legal):
 *  - Cadences are capped per platform; "aggressive" here means the fastest
 *    cadence that platforms' own automation rules tolerate, with jitter and
 *    copy variation. Reddit is deliberately slow — subreddits ban naked
 *    self-promotion fast; post only to communities whose rules allow it.
 *  - No engagement faking, no fake accounts, no scraping: official APIs only.
 */

import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('promoConnectors')

const env = (k) => {
  const v = process.env[k]
  return v && String(v).trim() ? String(v).trim() : null
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text?.slice(0, 400) } }
  if (!res.ok) {
    const err = new Error(`${options.method || 'GET'} ${new URL(url).host} → ${res.status}: ${JSON.stringify(body)?.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return body
}

// ── Threads (Meta) ───────────────────────────────────────────────────
// Two-step publish: create a media container, then publish it. Video rides
// along via a public URL. https://developers.facebook.com/docs/threads
const threads = {
  key: 'threads',
  label: 'Threads',
  supportsVideo: true,
  maxChars: 500,
  defaultCadenceMinutes: 180, // aggressive: ~8 posts/day
  requiredEnv: ['THREADS_ACCESS_TOKEN', 'THREADS_USER_ID'],
  setupHint: 'Meta developer app with the Threads API enabled; long-lived access token + your Threads user id.',
  isConfigured: () => Boolean(env('THREADS_ACCESS_TOKEN') && env('THREADS_USER_ID')),
  async post({ text, mediaUrl, mediaMime }) {
    const token = env('THREADS_ACCESS_TOKEN')
    const user = env('THREADS_USER_ID')
    const base = `https://graph.threads.net/v1.0/${encodeURIComponent(user)}`
    const isVideo = mediaUrl && /video/.test(mediaMime || '')
    const params = new URLSearchParams({ access_token: token, text })
    if (isVideo) {
      params.set('media_type', 'VIDEO')
      params.set('video_url', mediaUrl)
    } else if (mediaUrl) {
      params.set('media_type', 'IMAGE')
      params.set('image_url', mediaUrl)
    } else {
      params.set('media_type', 'TEXT')
    }
    const container = await jsonFetch(`${base}/threads`, { method: 'POST', body: params })
    // Video containers process asynchronously — poll briefly before publish.
    if (isVideo) await new Promise((r) => setTimeout(r, 15_000))
    const published = await jsonFetch(`${base}/threads_publish`, {
      method: 'POST',
      body: new URLSearchParams({ access_token: token, creation_id: container.id }),
    })
    return { external_id: published.id, external_url: null }
  },
}

// ── Bluesky (AT Protocol) ────────────────────────────────────────────
// Easiest to set up: just a handle + app password (Settings → App Passwords).
const bluesky = {
  key: 'bluesky',
  label: 'Bluesky',
  supportsVideo: false,
  maxChars: 300,
  defaultCadenceMinutes: 180,
  requiredEnv: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'],
  setupHint: 'Your handle (e.g. axiombiolabs.bsky.social) + an app password from Settings → App Passwords. No developer app needed.',
  isConfigured: () => Boolean(env('BLUESKY_HANDLE') && env('BLUESKY_APP_PASSWORD')),
  async post({ text, link, linkTitle }) {
    const session = await jsonFetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: env('BLUESKY_HANDLE'), password: env('BLUESKY_APP_PASSWORD') }),
    })
    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      ...(link ? {
        embed: {
          $type: 'app.bsky.embed.external',
          external: { uri: link, title: linkTitle || link, description: '' },
        },
      } : {}),
    }
    const res = await jsonFetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    })
    const rkey = String(res.uri || '').split('/').pop()
    return { external_id: res.uri, external_url: rkey ? `https://bsky.app/profile/${session.handle}/post/${rkey}` : null }
  },
}

// ── Mastodon ─────────────────────────────────────────────────────────
const mastodon = {
  key: 'mastodon',
  label: 'Mastodon',
  supportsVideo: false,
  maxChars: 500,
  defaultCadenceMinutes: 180,
  requiredEnv: ['MASTODON_BASE_URL', 'MASTODON_ACCESS_TOKEN'],
  setupHint: 'Any instance account: Preferences → Development → New application (write:statuses). Base URL e.g. https://mastodon.social.',
  isConfigured: () => Boolean(env('MASTODON_BASE_URL') && env('MASTODON_ACCESS_TOKEN')),
  async post({ text }) {
    const base = env('MASTODON_BASE_URL').replace(/\/+$/, '')
    const res = await jsonFetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env('MASTODON_ACCESS_TOKEN')}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ status: text, visibility: 'public' }),
    })
    return { external_id: res.id, external_url: res.url || null }
  },
}

// ── Telegram (channel) ───────────────────────────────────────────────
const telegram = {
  key: 'telegram',
  label: 'Telegram channel',
  supportsVideo: true,
  maxChars: 3800,
  defaultCadenceMinutes: 240,
  requiredEnv: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_PROMO_CHAT'],
  setupHint: 'Create a bot with @BotFather, add it as admin of your public channel, set TELEGRAM_PROMO_CHAT to @yourchannel.',
  isConfigured: () => Boolean(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_PROMO_CHAT')),
  async post({ text, mediaUrl, mediaMime }) {
    const base = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`
    const chat = env('TELEGRAM_PROMO_CHAT')
    let res
    if (mediaUrl && /video/.test(mediaMime || '')) {
      res = await jsonFetch(`${base}/sendVideo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, video: mediaUrl, caption: text.slice(0, 1024) }),
      })
    } else {
      res = await jsonFetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
      })
    }
    return { external_id: String(res?.result?.message_id ?? ''), external_url: null }
  },
}

// ── Discord (webhook) ────────────────────────────────────────────────
const discord = {
  key: 'discord',
  label: 'Discord (webhook)',
  supportsVideo: false,
  maxChars: 1900,
  defaultCadenceMinutes: 360,
  requiredEnv: ['DISCORD_PROMO_WEBHOOK_URL'],
  setupHint: 'Server → channel → Integrations → Webhooks → copy the webhook URL. Posts land in that channel.',
  isConfigured: () => Boolean(env('DISCORD_PROMO_WEBHOOK_URL')),
  async post({ text }) {
    await jsonFetch(`${env('DISCORD_PROMO_WEBHOOK_URL')}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    return { external_id: null, external_url: null }
  },
}

// ── X (Twitter) — OAuth 1.0a user context ────────────────────────────
function oauth1Header({ url, method, consumerKey, consumerSecret, token, tokenSecret }) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000).toString()
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: ts,
    oauth_token: token,
    oauth_version: '1.0',
  }
  const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const paramString = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&')
  const baseString = [method.toUpperCase(), enc(url), enc(paramString)].join('&')
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64')
  const header = { ...params, oauth_signature: signature }
  return 'OAuth ' + Object.keys(header).sort().map((k) => `${enc(k)}="${enc(header[k])}"`).join(', ')
}

const x = {
  key: 'x',
  label: 'X (Twitter)',
  supportsVideo: false,
  maxChars: 280,
  defaultCadenceMinutes: 360, // free API tier is write-capped — don't burn it
  requiredEnv: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'],
  setupHint: 'developer.x.com app (free tier allows a limited number of posts/month): consumer key/secret + access token/secret with write permission.',
  isConfigured: () => Boolean(env('X_API_KEY') && env('X_API_SECRET') && env('X_ACCESS_TOKEN') && env('X_ACCESS_SECRET')),
  async post({ text }) {
    const url = 'https://api.twitter.com/2/tweets'
    const auth = oauth1Header({
      url, method: 'POST',
      consumerKey: env('X_API_KEY'), consumerSecret: env('X_API_SECRET'),
      token: env('X_ACCESS_TOKEN'), tokenSecret: env('X_ACCESS_SECRET'),
    })
    const res = await jsonFetch(url, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const id = res?.data?.id || null
    return { external_id: id, external_url: id ? `https://x.com/i/status/${id}` : null }
  },
}

// ── Facebook Page ────────────────────────────────────────────────────
const facebookPage = {
  key: 'facebook_page',
  label: 'Facebook Page',
  supportsVideo: true,
  maxChars: 5000,
  defaultCadenceMinutes: 360,
  requiredEnv: ['FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN'],
  setupHint: 'Meta developer app + a Page you admin: page id + a long-lived Page access token with pages_manage_posts.',
  isConfigured: () => Boolean(env('FB_PAGE_ID') && env('FB_PAGE_ACCESS_TOKEN')),
  async post({ text, link, mediaUrl, mediaMime }) {
    const page = env('FB_PAGE_ID')
    const token = env('FB_PAGE_ACCESS_TOKEN')
    if (mediaUrl && /video/.test(mediaMime || '')) {
      const res = await jsonFetch(`https://graph.facebook.com/v21.0/${page}/videos`, {
        method: 'POST',
        body: new URLSearchParams({ access_token: token, file_url: mediaUrl, description: text }),
      })
      return { external_id: res.id, external_url: null }
    }
    const res = await jsonFetch(`https://graph.facebook.com/v21.0/${page}/feed`, {
      method: 'POST',
      body: new URLSearchParams({ access_token: token, message: text, ...(link ? { link } : {}) }),
    })
    return { external_id: res.id, external_url: null }
  },
}

// ── LinkedIn ─────────────────────────────────────────────────────────
const linkedin = {
  key: 'linkedin',
  label: 'LinkedIn',
  supportsVideo: false,
  maxChars: 2900,
  defaultCadenceMinutes: 720, // LinkedIn tolerates ~1-2 posts/day before feeds bury you
  requiredEnv: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_AUTHOR_URN'],
  setupHint: 'LinkedIn developer app with w_member_social (or w_organization_social); author URN like urn:li:person:xxxx or urn:li:organization:xxxx.',
  isConfigured: () => Boolean(env('LINKEDIN_ACCESS_TOKEN') && env('LINKEDIN_AUTHOR_URN')),
  async post({ text, link }) {
    const body = {
      author: env('LINKEDIN_AUTHOR_URN'),
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: link ? 'ARTICLE' : 'NONE',
          ...(link ? { media: [{ status: 'READY', originalUrl: link }] } : {}),
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }
    const res = await jsonFetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env('LINKEDIN_ACCESS_TOKEN')}`,
        'content-type': 'application/json',
        'x-restli-protocol-version': '2.0.0',
      },
      body: JSON.stringify(body),
    })
    return { external_id: res?.id || null, external_url: null }
  },
}

// ── Reddit ───────────────────────────────────────────────────────────
const reddit = {
  key: 'reddit',
  label: 'Reddit',
  supportsVideo: false,
  maxChars: 10_000,
  defaultCadenceMinutes: 2880, // every 2 days — subreddits ban aggressive self-promo
  requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD', 'REDDIT_SUBREDDIT'],
  setupHint: 'Script app at reddit.com/prefs/apps + account creds + ONE subreddit whose rules allow product posts (e.g. your own community). Self-promo elsewhere gets accounts banned.',
  isConfigured: () => Boolean(env('REDDIT_CLIENT_ID') && env('REDDIT_CLIENT_SECRET') && env('REDDIT_USERNAME') && env('REDDIT_PASSWORD') && env('REDDIT_SUBREDDIT')),
  async post({ text, link, title }) {
    const basic = Buffer.from(`${env('REDDIT_CLIENT_ID')}:${env('REDDIT_CLIENT_SECRET')}`).toString('base64')
    const tokenRes = await jsonFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'grantflow-promo/1.0' },
      body: new URLSearchParams({ grant_type: 'password', username: env('REDDIT_USERNAME'), password: env('REDDIT_PASSWORD') }),
    })
    const res = await jsonFetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenRes.access_token}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'grantflow-promo/1.0' },
      body: new URLSearchParams({
        sr: env('REDDIT_SUBREDDIT'),
        kind: link ? 'link' : 'self',
        title: (title || text.split('\n')[0]).slice(0, 290),
        ...(link ? { url: link } : { text }),
        api_type: 'json',
      }),
    })
    const data = res?.json?.data || {}
    return { external_id: data.name || null, external_url: data.url || null }
  },
}

export const PLATFORMS = [threads, bluesky, mastodon, telegram, discord, x, facebookPage, linkedin, reddit]

export function getPlatform(key) {
  return PLATFORMS.find((p) => p.key === key) || null
}

export function platformStatus() {
  return PLATFORMS.map((p) => ({
    key: p.key,
    label: p.label,
    supports_video: p.supportsVideo,
    max_chars: p.maxChars,
    default_cadence_minutes: p.defaultCadenceMinutes,
    required_env: p.requiredEnv,
    setup_hint: p.setupHint,
    configured: p.isConfigured(),
  }))
}

export default { PLATFORMS, getPlatform, platformStatus }

void log
