/**
 * purgeVerification.js
 *
 * Primary-source verification probes for the regional purge system.
 *
 * Verification levels:
 *   primary   – HTTP 410/404 confirmed, or authoritative page says closed
 *   secondary – ambiguous signal (e.g. 404 from a non-authoritative mirror)
 *   none      – no verifiable signal found
 *
 * Returns:
 *   { verified, signals, verificationLevel, statusHint }
 *
 * Where:
 *   verified          – true only when verificationLevel === 'primary'
 *   signals           – array of signal objects with { type, value, detail }
 *   verificationLevel – 'primary' | 'secondary' | 'none'
 *   statusHint        – 'closed' | 'active' | 'unknown'
 */

// Phrases that strongly indicate a program is closed / no longer accepting
const CLOSED_PHRASES = [
  /\bno longer accepting\b/i,
  /\bapplications?\s+(?:are\s+)?closed\b/i,
  /\bfunding\s+(?:has\s+)?(?:been\s+)?(?:fully\s+)?awarded\b/i,
  /\bprogram\s+(?:has\s+)?(?:been\s+)?(?:closed|ended|discontinued|expired)\b/i,
  /\bdeadline\s+(?:has\s+)?passed\b/i,
  /\bno\s+longer\s+available\b/i,
  /\bthis\s+grant\s+(?:is|has\s+been)\s+closed\b/i,
  /\bnot\s+(?:currently\s+)?(?:accepting|open\s+for)\s+(?:new\s+)?applications?\b/i,
  /\bfunding\s+(?:cycle\s+)?(?:for\s+\d{4}\s+)?(?:is\s+)?closed\b/i,
  /\bclosed\s+to\s+(?:new\s+)?applications?\b/i,
]

// Phrases that suggest the program is still active
const ACTIVE_PHRASES = [
  /\bapply\s+now\b/i,
  /\bapplications?\s+(?:are\s+)?(?:now\s+)?open\b/i,
  /\bsubmit\s+(?:your\s+)?application\b/i,
  /\bdeadline[:\s]+[A-Za-z]+\s+\d/i,
  /\bopen\s+for\s+applications?\b/i,
]

/**
 * Probe a source URL for verification signals.
 *
 * @param {string} sourceUrl  - URL of the opportunity page
 * @param {object} [options]
 * @param {Function} [options.fetchFn]  - injectable fetch (defaults to global fetch)
 * @param {number}  [options.timeoutMs] - request timeout (default 12 000 ms)
 * @returns {Promise<{verified:boolean, signals:Array, verificationLevel:string, statusHint:string}>}
 */
export async function verifyOpportunityUrl(sourceUrl, { fetchFn, timeoutMs = 12000 } = {}) {
  const signals = []
  let verificationLevel = 'none'
  let statusHint = 'unknown'

  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return { verified: false, signals, verificationLevel, statusHint }
  }

  const fetch_ = fetchFn ?? globalThis.fetch
  if (!fetch_) {
    signals.push({ type: 'fetch_unavailable', value: 'error', detail: 'No fetch implementation available - inject fetchFn or run in an environment with globalThis.fetch' })
    return { verified: false, signals, verificationLevel, statusHint }
  }

  let httpStatus = null
  let responseText = null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch_(sourceUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'GrantFlow-PurgeBot/1.0 (+https://grantflow.app)' },
        redirect: 'follow',
      })
      httpStatus = res.status
      try { responseText = await res.text() } catch (err) { signals.push({ type: 'response_parse_error', value: 'warning', detail: err?.message || 'Failed to parse response text' }) }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    signals.push({ type: 'fetch_error', value: 'error', detail: err?.message || String(err) })
    return { verified: false, signals, verificationLevel, statusHint }
  }

  signals.push({ type: 'http_status', value: String(httpStatus), detail: sourceUrl })

  // ── HTTP 410 Gone → definitive closed signal ───────────────────────────────
  if (httpStatus === 410) {
    verificationLevel = 'primary'
    statusHint = 'closed'
    signals.push({ type: 'http_410', value: 'gone', detail: 'HTTP 410 Gone response received' })
    return { verified: true, signals, verificationLevel, statusHint }
  }

  // ── HTTP 404 Not Found → secondary signal (page may have moved) ───────────
  if (httpStatus === 404) {
    verificationLevel = 'secondary'
    statusHint = 'closed'
    signals.push({ type: 'http_404', value: 'not_found', detail: 'HTTP 404 Not Found' })
    // Do not return early — also try to parse the body if available.
  }

  if (!responseText) {
    return { verified: verificationLevel === 'primary', signals, verificationLevel, statusHint }
  }

  // ── JSON-LD / schema.org probe ─────────────────────────────────────────────
  const jsonLdResult = extractJsonLdSignals(responseText, sourceUrl)
  if (jsonLdResult.signals.length > 0) {
    signals.push(...jsonLdResult.signals)
    if (jsonLdResult.statusHint === 'closed') {
      verificationLevel = 'primary'
      statusHint = 'closed'
    } else if (jsonLdResult.statusHint === 'active') {
      statusHint = 'active'
    }
  }

  if (verificationLevel === 'primary') {
    return { verified: true, signals, verificationLevel, statusHint }
  }

  // ── Page text probe ────────────────────────────────────────────────────────
  const textResult = extractTextSignals(responseText)
  signals.push(...textResult.signals)

  if (textResult.statusHint === 'closed') {
    verificationLevel = 'primary'
    statusHint = 'closed'
  } else if (textResult.statusHint === 'active') {
    statusHint = 'active'
    // Active signal overrides a prior secondary 404 hint.
    if (verificationLevel === 'secondary') verificationLevel = 'none'
  }

  const verified = verificationLevel === 'primary'
  return { verified, signals, verificationLevel, statusHint }
}

// ─── JSON-LD / schema.org extractor ──────────────────────────────────────────

function extractJsonLdSignals(html, _url) {
  const signals = []
  let statusHint = 'unknown'

  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        // EventStatus / EventStatusType
        const eventStatus = item?.eventStatus || item?.['schema:eventStatus'] || ''
        if (/cancelled|closed|ended/i.test(String(eventStatus))) {
          signals.push({ type: 'schema_status', value: 'closed', detail: String(eventStatus) })
          statusHint = 'closed'
        }

        // Grant / Offer status
        const offerStatus = item?.availability || item?.offerStatus || ''
        if (/discontinued|closed/i.test(String(offerStatus))) {
          signals.push({ type: 'schema_offer_status', value: 'closed', detail: String(offerStatus) })
          statusHint = 'closed'
        }

        // dateModified being in the past is a weak positive signal
        const dateModified = item?.dateModified || ''
        if (dateModified) {
          signals.push({ type: 'schema_date_modified', value: dateModified, detail: 'schema.org dateModified' })
        }
      }
    } catch {
      // Malformed JSON-LD — skip
    }
  }

  return { signals, statusHint }
}

// ─── Page text extractor ──────────────────────────────────────────────────────

function extractTextSignals(html) {
  const signals = []
  let statusHint = 'unknown'

  // Strip tags for plain text analysis.
  //
  // NON-PROSE BODIES MUST GO FIRST. `html.replace(/<[^>]+>/g, ' ')` removes the
  // <script>/<style> TAGS but leaves their BODIES in the text — so a JS string
  // literal, an analytics payload, a templating stub, or an HTML comment could
  // supply a CLOSED_PHRASES hit. That hit sets verificationLevel='primary' →
  // verified:true, which the purge system treats as authoritative evidence that
  // the opportunity is dead. A funder's live page that merely SHIPS the words
  // "no longer accepting applications" inside a script bundle would have had its
  // real funding source deleted. Verification evidence must come from copy a
  // human could actually read on the page.
  const visibleHtml = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
  const plainText = visibleHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  for (const phrase of CLOSED_PHRASES) {
    if (phrase.test(plainText)) {
      signals.push({ type: 'closed_phrase', value: 'closed', detail: phrase.source })
      statusHint = 'closed'
      break
    }
  }

  if (statusHint !== 'closed') {
    for (const phrase of ACTIVE_PHRASES) {
      if (phrase.test(plainText)) {
        signals.push({ type: 'active_phrase', value: 'active', detail: phrase.source })
        statusHint = 'active'
        break
      }
    }
  }

  return { signals, statusHint }
}
