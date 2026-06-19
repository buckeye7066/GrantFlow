/**
 * Yana — urgency scoring (legacy filename `larryUrgencyScorer.js`).
 *
 * Urgency is "why now?". A merely fitting org is interesting; a merely fitting
 * org with an active capital campaign is *urgent*. Urgency surfaces orgs that
 * are likely actively shopping for tools or funders right now.
 *
 * Inputs are the same `signals_json` payloads collected during discovery.
 * No PII or sensitive data is required — only public signals like recent
 * news mentions, posted deadlines, and visible campaign pages.
 */

import { URGENCY_REASON_CODES } from './larryTypes.js'

function recentNews(signals) {
  if (!signals?.news_mentions_recent) return []
  return Array.isArray(signals.news_mentions_recent) ? signals.news_mentions_recent : []
}

function recentDisaster(signals) {
  return Boolean(signals?.recent_disaster_in_region)
}

export function computeUrgencyScore(prospect, { now = new Date(), config = null } = {}) {
  void config
  if (!prospect || typeof prospect !== 'object') return { score: 0, reasons: [] }
  const reasons = []
  let score = 0
  const signals = prospect.signals_json && typeof prospect.signals_json === 'object' ? prospect.signals_json : {}

  if (signals.active_capital_campaign) {
    score += 25
    reasons.push({
      code: URGENCY_REASON_CODES.ACTIVE_CAPITAL_CAMPAIGN,
      weight: 25,
      detail: typeof signals.active_capital_campaign === 'string' ? signals.active_capital_campaign : 'campaign listed',
    })
  }

  if (recentDisaster(signals)) {
    score += 20
    reasons.push({
      code: URGENCY_REASON_CODES.RECENT_DISASTER_IN_REGION,
      weight: 20,
      detail: typeof signals.recent_disaster_in_region === 'string' ? signals.recent_disaster_in_region : 'recent regional disaster',
    })
  }

  if (signals.upcoming_grant_deadline) {
    const deadlineDate = new Date(signals.upcoming_grant_deadline)
    if (Number.isFinite(deadlineDate.getTime())) {
      const diffDays = Math.round((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      if (diffDays >= 0 && diffDays <= 60) {
        score += 15
        reasons.push({
          code: URGENCY_REASON_CODES.PUBLIC_FUNDING_DEADLINE_PRESSURE,
          weight: 15,
          detail: `deadline in ${diffDays} days`,
        })
      }
    }
  }

  if (signals.recent_staff_change || signals.new_executive_director) {
    score += 10
    reasons.push({
      code: URGENCY_REASON_CODES.STAFF_TRANSITION_SIGNAL,
      weight: 10,
      detail: signals.recent_staff_change || signals.new_executive_director,
    })
  }

  if (signals.recent_grant_denial) {
    score += 10
    reasons.push({
      code: URGENCY_REASON_CODES.RECENT_GRANT_DENIAL,
      weight: 10,
      detail: signals.recent_grant_denial,
    })
  }

  if (signals.new_program_launch) {
    score += 10
    reasons.push({
      code: URGENCY_REASON_CODES.NEW_PROGRAM_LAUNCH,
      weight: 10,
      detail: signals.new_program_launch,
    })
  }

  const news = recentNews(signals)
  if (news.length > 0) {
    score += Math.min(10, 3 * news.length)
    reasons.push({
      code: URGENCY_REASON_CODES.RECENT_NEWS_COVERAGE,
      weight: Math.min(10, 3 * news.length),
      detail: `${news.length} recent news mention(s)`,
    })
  }

  return { score: Math.max(0, Math.min(100, score)), reasons }
}

/**
 * Combine fit and urgency into a single composite score. Fit dominates
 * because we'd rather miss a hot opportunity than chase a poorly-fit org.
 */
export function computeCompositeScore({ fit_score = 0, urgency_score = 0 } = {}) {
  const f = Math.max(0, Math.min(100, Number(fit_score) || 0))
  const u = Math.max(0, Math.min(100, Number(urgency_score) || 0))
  // 70% fit + 30% urgency, clamped 0..100.
  return Math.round(0.7 * f + 0.3 * u)
}
