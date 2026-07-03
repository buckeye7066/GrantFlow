/**
 * promoContent.js — writes the promo copy for a (app × platform) post.
 *
 * "Aggressive" cadence only works if every post reads fresh, so generation is
 * ANGLE-ROTATED: each post takes the next angle in the wheel (pain-point,
 * feature spotlight, founder story, how-it-works, call-to-action, question
 * hook, …) and the LLM writes to that angle within the platform's length
 * limit. HONESTY RULE: no invented statistics, testimonials, reviews, or
 * awards — the copy sells what the product actually does, from the app's own
 * description fields. Falls back to deterministic templates when no AI
 * provider is configured, so a checked box always posts something real.
 */

import { createOpenAIClient } from '../../utils/openaiClient.js'
import { DEFAULT_OPENAI_MODEL } from '../../config/constants.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('promoContent')

export const ANGLES = [
  'pain-point: open with the frustrating problem this audience lives with, then the relief',
  'feature spotlight: pick ONE concrete capability and make it vivid',
  'founder story: built by Dr. John White at Axiom BioLabs to solve his own problem first',
  'how-it-works: a 3-beat walkthrough of what happens after you sign up',
  'call-to-action: direct, confident invitation to try it now',
  'question hook: open with a question the audience says yes to, then answer it',
  'audience callout: name the exact person this is for and why today',
  'before/after: the workflow without it vs with it (no invented numbers)',
]

function truncateAtWord(text, max) {
  const t = String(text || '').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30))}…`
}

/** Deterministic fallback (also the guaranteed floor under LLM outages). */
export function templateCopy(app, platform, angleIndex = 0) {
  const hooks = [
    `${app.tagline}`,
    `Meet ${app.name}: ${app.tagline}`,
    `For ${app.audience || 'you'} — ${app.tagline}`,
    `${app.name} exists because ${String(app.description || '').split('.')[0].toLowerCase()}.`,
  ]
  const hook = hooks[angleIndex % hooks.length]
  const body = truncateAtWord(app.description || '', Math.max(80, platform.maxChars - hook.length - (app.url?.length || 0) - (app.hashtags?.length || 0) - 8))
  const parts = [hook, body, app.url, platform.maxChars >= 300 ? app.hashtags : null].filter(Boolean)
  return truncateAtWord(parts.join('\n\n'), platform.maxChars)
}

/**
 * Generate one post's text for app × platform. `sequence` drives angle
 * rotation (use the platform's lifetime post count).
 */
export async function generatePromoCopy(app, platform, { sequence = 0, openai = null } = {}) {
  const angle = ANGLES[sequence % ANGLES.length]
  const client = openai || createOpenAIClient()
  if (!client) return { text: templateCopy(app, platform, sequence), angle, provider: 'template' }

  const prompt = `You write high-converting social posts for real software products. Write ONE post promoting this product for ${platform.label}.

PRODUCT
Name: ${app.name}
Tagline: ${app.tagline || ''}
What it does: ${app.description || ''}
Audience: ${app.audience || 'general'}
Link: ${app.url || ''}
Hashtags to draw from (use ${platform.maxChars >= 300 ? '2-4' : '0-2'}, only if natural): ${app.hashtags || ''}

ANGLE FOR THIS POST (vary from previous posts): ${angle}

HARD RULES
- Max ${platform.maxChars} characters TOTAL including the link and hashtags. This is a hard platform limit.
- Include the link ${app.url ? `(${app.url})` : ''} unless the platform auto-attaches it.
- ABSOLUTE HONESTY: never invent statistics, user counts, testimonials, reviews, awards, or guarantees. Sell only what the description says the product does.
- Energetic and confident, not spammy: no ALL-CAPS shouting, at most one emoji, no "🚀🚀🚀" walls, no clickbait lies.
- Plain text only (no markdown headers).

Return ONLY the post text.`

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 400,
    })
    const raw = completion?.choices?.[0]?.message?.content?.trim()
    if (raw) return { text: truncateAtWord(raw, platform.maxChars), angle, provider: 'openai' }
  } catch (err) {
    log.warn('LLM copy failed, using template', { error: err?.message })
  }
  return { text: templateCopy(app, platform, sequence), angle, provider: 'template' }
}

export default { generatePromoCopy, templateCopy, ANGLES }
