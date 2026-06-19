/**
 * Yana — safety helpers, env config, and pre-flight predicates
 * (legacy filename `larrySafety.js`).
 *
 * Everything the Yana lead pipeline does on the open web or against a recipient must pass
 * through one of these gates before more expensive verification, drafting, or
 * sending logic runs. The gates are intentionally cheap and pure so they can
 * be unit-tested without a database, network, or email provider.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled', ''])

function readEnv(name) {
  const v = process.env?.[name]
  if (v === undefined || v === null) return null
  return String(v).trim()
}

export function readEnvBool(name, fallback = false) {
  const v = readEnv(name)
  if (v === null) return fallback
  const lower = v.toLowerCase()
  if (TRUE_VALUES.has(lower)) return true
  if (FALSE_VALUES.has(lower)) return false
  return fallback
}

export function readEnvInt(name, fallback) {
  const v = readEnv(name)
  if (v === null || v === '') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export function readEnvString(name, fallback = null) {
  const v = readEnv(name)
  if (v === null || v === '') return fallback
  return v
}

// Canonical env-var names use the YANA_LEADS_* prefix; the legacy
// LARRY_* spellings are still honoured as a fallback so existing
// deployments don't have to flip every flag at once.
function readBoolPref(canonicalName, legacyName, fallback) {
  const canonicalRaw = readEnv(canonicalName)
  if (canonicalRaw !== null && canonicalRaw !== '') return readEnvBool(canonicalName, fallback)
  return readEnvBool(legacyName, fallback)
}
function readIntPref(canonicalName, legacyName, fallback) {
  const canonicalRaw = readEnv(canonicalName)
  if (canonicalRaw !== null && canonicalRaw !== '') return readEnvInt(canonicalName, fallback)
  return readEnvInt(legacyName, fallback)
}
function readStringPref(canonicalName, legacyName, fallback) {
  const canonicalRaw = readEnv(canonicalName)
  if (canonicalRaw !== null && canonicalRaw !== '') return readEnvString(canonicalName, fallback)
  return readEnvString(legacyName, fallback)
}

/**
 * Centralized Yana lead-pipeline runtime configuration. Reading happens at
 * call time so tests can mutate `process.env` and immediately see the change.
 * Defaults are deliberately conservative: the agent is **off** unless the
 * operator opts in, and even when on it stays in observe mode unless the
 * operator opts in further.
 *
 * Env-var precedence per setting: `YANA_LEADS_*` (canonical) first, then
 * `LARRY_*` (legacy) as fallback. Both spellings keep working.
 */
export function getLarryConfig() {
  return {
    enabled: readBoolPref('YANA_LEADS_ENABLED', 'LARRY_ENABLED', false),
    runOnStartup: readBoolPref('YANA_LEADS_RUN_ON_STARTUP', 'LARRY_RUN_ON_STARTUP', false),
    runOnSchedule: readBoolPref('YANA_LEADS_RUN_ON_SCHEDULE', 'LARRY_RUN_ON_SCHEDULE', false),
    schedule: readStringPref('YANA_LEADS_SCHEDULE', 'LARRY_SCHEDULE', '0 * * * *'),
    mode: readStringPref('YANA_LEADS_MODE', 'LARRY_MODE', 'observe'),
    maxProspectsPerRun: readIntPref('YANA_LEADS_MAX_PROSPECTS_PER_RUN', 'LARRY_MAX_PROSPECTS_PER_RUN', 50),
    maxVerifiesPerRun: readIntPref('YANA_LEADS_MAX_VERIFIES_PER_RUN', 'LARRY_MAX_VERIFIES_PER_RUN', 100),
    maxLeadsPerRun: readIntPref('YANA_LEADS_MAX_LEADS_PER_RUN', 'LARRY_MAX_LEADS_PER_RUN', 50),
    maxOutreachDraftsPerRun: readIntPref('YANA_LEADS_MAX_OUTREACH_DRAFTS_PER_RUN', 'LARRY_MAX_OUTREACH_DRAFTS_PER_RUN', 20),
    maxOutreachSendsPerDay: readIntPref('YANA_LEADS_MAX_OUTREACH_SENDS_PER_DAY', 'LARRY_MAX_OUTREACH_SENDS_PER_DAY', 25),
    timeoutMs: readIntPref('YANA_LEADS_TIMEOUT_MS', 'LARRY_TIMEOUT_MS', 15000),
    allowLiveWeb: readBoolPref('YANA_LEADS_ALLOW_LIVE_WEB', 'LARRY_ALLOW_LIVE_WEB', false),
    allowSearchEngine: readBoolPref('YANA_LEADS_ALLOW_SEARCH_ENGINE', 'LARRY_ALLOW_SEARCH_ENGINE', false),
    persistProspects: readBoolPref('YANA_LEADS_PERSIST_PROSPECTS', 'LARRY_PERSIST_PROSPECTS', true),
    autoQualify: readBoolPref('YANA_LEADS_AUTO_QUALIFY', 'LARRY_AUTO_QUALIFY', false),
    autoDraftOutreach: readBoolPref('YANA_LEADS_AUTO_DRAFT_OUTREACH', 'LARRY_AUTO_DRAFT_OUTREACH', false),
    autoSendOutreach: readBoolPref('YANA_LEADS_AUTO_SEND_OUTREACH', 'LARRY_AUTO_SEND_OUTREACH', false),
    requireApprovalToSend: readBoolPref('YANA_LEADS_REQUIRE_APPROVAL_TO_SEND', 'LARRY_REQUIRE_APPROVAL_TO_SEND', true),
    minFitScore: readIntPref('YANA_LEADS_MIN_FIT_SCORE', 'LARRY_MIN_FIT_SCORE', 60),
    minCompositeScore: readIntPref('YANA_LEADS_MIN_COMPOSITE_SCORE', 'LARRY_MIN_COMPOSITE_SCORE', 65),
    respectRobots: readBoolPref('YANA_LEADS_RESPECT_ROBOTS', 'LARRY_RESPECT_ROBOTS', true),
    userAgent: readStringPref('YANA_LEADS_USER_AGENT', 'LARRY_USER_AGENT', 'GrantFlowYanaBot/1.0'),
    rateLimitPerDomainPerHour: readIntPref('YANA_LEADS_RATE_LIMIT_PER_DOMAIN_PER_HOUR', 'LARRY_RATE_LIMIT_PER_DOMAIN_PER_HOUR', 30),
    failOpen: readBoolPref('YANA_LEADS_FAIL_OPEN', 'LARRY_FAIL_OPEN', false),
    fromEmail: readStringPref('YANA_LEADS_FROM_EMAIL', 'LARRY_FROM_EMAIL', readEnvString('FROM_EMAIL', readEnvString('EMAIL_FROM', null))),
    replyToEmail: readStringPref('YANA_LEADS_REPLY_TO_EMAIL', 'LARRY_REPLY_TO_EMAIL', null),
    bccCompliance: readStringPref('YANA_LEADS_BCC_COMPLIANCE', 'LARRY_BCC_COMPLIANCE', null),
    pauseOnSendErrorThreshold: readIntPref('YANA_LEADS_PAUSE_ON_SEND_ERROR_THRESHOLD', 'LARRY_PAUSE_ON_SEND_ERROR_THRESHOLD', 3),
  }
}

/**
 * Mask any API keys / secrets that may leak into logs or admin responses.
 * Mirrors the helper Robert ships so logs across both agents stay consistent.
 */
export function maskSecrets(input) {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return maskSecretString(input)
  if (Array.isArray(input)) return input.map((item) => maskSecrets(item))
  if (typeof input === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(input)) {
      if (looksLikeSecretKey(k)) {
        out[k] = typeof v === 'string' ? `***${v.length}c` : '***'
      } else {
        out[k] = maskSecrets(v)
      }
    }
    return out
  }
  return input
}

function looksLikeSecretKey(name) {
  const lower = String(name || '').toLowerCase()
  return /(secret|token|key|password|authorization|api[_-]?key|bearer)/.test(lower)
}

function maskSecretString(s) {
  // Mask Bearer tokens, sk-/pk- prefixed keys, long contiguous hex/base64 blocks.
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/(sk|pk|rk|api)[_-]?[A-Za-z0-9]{16,}/gi, (match) => `${match.slice(0, 4)}***`)
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***')
}

/**
 * Loose URL safety predicate. Yana refuses to call placeholder hosts so a
 * misconfigured source doesn't cause real outbound traffic to example.com.
 */
const PLACEHOLDER_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'foo.com',
  'bar.com',
  'localhost',
])

export function isPlaceholderUrl(url) {
  if (!url || typeof url !== 'string') return true
  try {
    const u = new URL(url)
    if (!u.hostname) return true
    if (PLACEHOLDER_HOSTS.has(u.hostname.toLowerCase())) return true
    if (/127\.0\.0\.1|0\.0\.0\.0/.test(u.hostname)) return true
    return false
  } catch {
    return true
  }
}

const SEARCH_ENGINE_HOSTS = new Set([
  'google.com',
  'www.google.com',
  'bing.com',
  'www.bing.com',
  'duckduckgo.com',
  'www.duckduckgo.com',
  'search.yahoo.com',
])

export function isSearchEngineUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return SEARCH_ENGINE_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'live.com',
  'protonmail.com',
])

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'tempmail.com',
  'guerrillamail.com',
  'throwawaymail.com',
  'sharklasers.com',
  'yopmail.com',
])

const ROLE_LIKE_EMAIL_LOCALS = new Set([
  'info',
  'contact',
  'hello',
  'support',
  'admin',
  'noreply',
  'no-reply',
  'webmaster',
  'sales',
  'marketing',
  'billing',
])

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function classifyEmail(email) {
  const result = {
    valid: false,
    is_role: false,
    is_disposable: false,
    is_generic_provider: false,
    is_org_email: false,
    domain: null,
  }
  if (!email || typeof email !== 'string') return result
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) return result
  result.valid = true
  const [local, domain] = trimmed.split('@')
  result.domain = domain
  if (ROLE_LIKE_EMAIL_LOCALS.has(local)) result.is_role = true
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) result.is_disposable = true
  if (GENERIC_EMAIL_DOMAINS.has(domain)) result.is_generic_provider = true
  if (!result.is_disposable && !result.is_generic_provider) result.is_org_email = true
  return result
}

const PHONE_DIGITS_RE = /\d/g

export function classifyPhone(phone) {
  const result = { valid: false, e164_like: null, digit_count: 0 }
  if (!phone || typeof phone !== 'string') return result
  const digits = (phone.match(PHONE_DIGITS_RE) || []).join('')
  result.digit_count = digits.length
  if (digits.length === 10) {
    result.valid = true
    result.e164_like = `+1${digits}`
  } else if (digits.length === 11 && digits.startsWith('1')) {
    result.valid = true
    result.e164_like = `+${digits}`
  } else if (digits.length >= 11 && digits.length <= 15) {
    result.valid = true
    result.e164_like = `+${digits}`
  }
  return result
}

/**
 * Pre-flight check: should Yana refuse to draft an outreach against this
 * prospect? Returns null if OK, otherwise a {reason, detail} block.
 */
export function checkProspectIsDraftable(prospect) {
  if (!prospect || typeof prospect !== 'object') {
    return { reason: 'invalid_prospect', detail: 'prospect missing' }
  }
  if (!prospect.organization_name || !String(prospect.organization_name).trim()) {
    return { reason: 'no_name', detail: 'organization_name is empty' }
  }
  if (prospect.do_not_contact === 1 || prospect.do_not_contact === true) {
    return { reason: 'do_not_contact', detail: prospect.do_not_contact_reason || 'flagged DNC' }
  }
  return null
}

/**
 * Pre-flight check for the *send* step. Mirrors the Robert pattern: returns
 * null when safe to send, otherwise a structured {reason, detail} so the
 * admin console can surface the exact reason a send was blocked.
 */
export function checkSendIsAllowed({ attempt, prospect, relationship, suppressionHits = [], config = null } = {}) {
  const cfg = config || getLarryConfig()

  if (!cfg.enabled) {
    return { reason: 'agent_disabled', detail: 'YANA_LEADS_ENABLED/LARRY_ENABLED=false' }
  }

  if (!attempt) {
    return { reason: 'invalid_attempt', detail: 'attempt missing' }
  }
  if (cfg.requireApprovalToSend && !attempt.approved_at && !attempt.approved_by_user_id) {
    return { reason: 'send_not_approved', detail: 'admin approval required before send' }
  }

  if (attempt.channel === 'email') {
    const recipient = attempt.sent_to_email || prospect?.primary_contact_email
    if (!recipient) {
      return { reason: 'recipient_missing', detail: 'no email recipient on attempt or prospect' }
    }
    const cls = classifyEmail(recipient)
    if (!cls.valid) {
      return { reason: 'recipient_invalid', detail: `email ${recipient} failed format check` }
    }
    if (cls.is_disposable) {
      return { reason: 'recipient_invalid', detail: `${recipient} is on disposable-email list` }
    }
  }

  if (suppressionHits && suppressionHits.length > 0) {
    return { reason: 'on_suppression_list', detail: `suppressed by ${suppressionHits.length} entry(ies)` }
  }

  if (relationship?.do_not_contact === 1 || relationship?.do_not_contact === true) {
    return {
      reason: 'relationship_do_not_contact',
      detail: relationship.do_not_contact_reason || 'relationship DNC',
    }
  }

  if (relationship?.cooldown_until) {
    const cooldown = new Date(relationship.cooldown_until)
    if (Number.isFinite(cooldown.getTime()) && cooldown.getTime() > Date.now()) {
      return { reason: 'cooldown_active', detail: `cooldown until ${cooldown.toISOString()}` }
    }
  }

  return null
}
