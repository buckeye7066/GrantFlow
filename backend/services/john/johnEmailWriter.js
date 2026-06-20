/**
 * John — email writer.
 *
 * Pure function: takes a Yana lead packet + an interpretation result + the
 * John config, and returns a fully-rendered { subject, body_text, body_html,
 * personalization } object.
 *
 * No I/O, no calls to LLMs. The output is deterministic and audit-friendly:
 * the Admin UI can show the personalization vars next to the rendered body
 * so reviewers see exactly which Yana fields produced which sentences.
 */

import { fillTemplate, pickSubjectTemplate, TEMPLATES, frameForType, OPT_OUT_LINE } from './johnEmailTemplates.js'
import { interpretLead } from './johnLeadInterpreter.js'
import { getJohnConfig } from './johnOutreachSafety.js'
import { aiComposerEnabled, composeEmailWithAI } from './johnEmailComposerAI.js'
import { extractOrgSignals } from './johnEvidenceSufficiency.js'

/**
 * Build a clean, list-style noun phrase from Yana's focus/program areas (e.g.
 * "education and youth mentoring"). These are tag-like and read naturally
 * mid-sentence. Returns null when there are none \u2014 free-text/mission detail is
 * carried by the attention line instead (where a colon frame keeps it
 * grammatical), so the opening never says "looking into opened a saturday\u2026".
 */
function deriveHookPhrase(signals) {
  const tags = [...(signals.focusAreas || []), ...(signals.programAreas || [])]
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 3)
  if (!tags.length) return null
  const lowered = tags.map((t) => (/[A-Z]{2,}/.test(t) ? t : t.toLowerCase()))
  if (lowered.length === 1) return lowered[0]
  if (lowered.length === 2) return `${lowered[0]} and ${lowered[1]}`
  return `${lowered.slice(0, -1).join(', ')}, and ${lowered[lowered.length - 1]}`
}

/** A short topic slug for the subject line / personalization audit. */
function deriveEvidenceTopic(signals, hookPhrase) {
  if (hookPhrase) return hookPhrase
  const text = String(signals.hookText || '').trim()
  if (!text) return null
  const clause = text.split(/[.!?;\u2014\u2013]\s/)[0].trim()
  return clause.length <= 60 ? clause : clause.slice(0, 60).trim() + '\u2026'
}

/**
 * Compose the opening line. Specific when we have clean focus/program tags;
 * warm-but-honest when we don't (instead of the old "\u2026doing meaningful work
 * around community-focused funding work" which collided "work" with "work").
 */
function buildOpeningLine(orgName, hookPhrase) {
  const org = orgName || 'your organization'
  if (hookPhrase) {
    return `I came across ${org} while looking into ${hookPhrase}, and your work stood out enough that I wanted to reach out directly.`
  }
  return `I came across ${org} while looking for organizations whose mission tends to outrun their budget \u2014 and from what I can see, yours is doing real work that deserves to be funded.`
}

/**
 * Compose the "what stood out" sentence that leads the value paragraph. Empty
 * string when we have no specific detail, so the paragraph flows straight into
 * "Here is the short version:" without an awkward dangling claim.
 */
function buildAttentionLine(orgName, signals) {
  const org = orgName || 'your organization'
  const detail = String(signals.hookText || '').trim()
  if (!detail) return ''
  const trimmed = detail.length <= 200 ? detail : detail.slice(0, 200).trim() + '\u2026'
  const punctuated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  return `What stayed with me about ${org} was this: ${punctuated} `
}

function htmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function textToHtml(text) {
  const escaped = htmlEscape(text)
  const paragraphs = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
  return `<!doctype html><html><body>${paragraphs.join('')}</body></html>`
}

/**
 * Compose an email from a lead.
 *
 * Tries the AI composer first (personalized, MBA-quality copy that speaks to the
 * org's mission/goals and how GrantFlow helps). Falls back to the deterministic
 * template when AI is disabled, unavailable, or its output fails John's safety
 * classifiers — so John always produces a compliant draft.
 *
 * Async because the AI path performs a network call. Returns an object
 * describing both the rendered email and the personalization decisions,
 * suitable for storing in john_email_drafts.personalization_json.
 */
export async function composeEmailFromLead(lead, opts = {}) {
  const config = opts.config || getJohnConfig()
  const interpretation = opts.interpretation || interpretLead(lead)

  if (aiComposerEnabled(config)) {
    try {
      const ai = await composeEmailWithAI(lead, { config, interpretation, logger: opts.logger })
      if (ai?.ok) return ai
    } catch (err) {
      opts.logger?.warn?.('[John] AI composer threw; using template', { error: err?.message })
    }
  }
  return composeWithTemplate(lead, { config, interpretation })
}

/**
 * Deterministic template composer (the original, always-available path).
 */
export function composeWithTemplate(lead, opts = {}) {
  const config = opts.config || getJohnConfig()
  const interpretation = opts.interpretation || interpretLead(lead)

  const signals = extractOrgSignals(lead)
  const orgName = interpretation.organization_name || 'your organization'
  const hookPhrase = deriveHookPhrase(signals)
  const evidenceTopic = deriveEvidenceTopic(signals, hookPhrase)
  const openingLine = buildOpeningLine(interpretation.organization_name, hookPhrase)
  const attentionLine = buildAttentionLine(interpretation.organization_name, signals)
  const recipientEmail = interpretation?.contact?.email || null

  // Only steer the subject toward the "Quick note about <topic>" form when we
  // have a genuinely specific, short hook; otherwise fall back to the org-name
  // subject so we never ship "Quick note about community-focused funding work".
  const subjectTopic = evidenceTopic && evidenceTopic.length <= 50 ? evidenceTopic : null
  const subjectTemplate = pickSubjectTemplate({
    organization_name: interpretation.organization_name,
    evidence_topic: subjectTopic,
  })

  const subject = fillTemplate(subjectTemplate, {
    ORGANIZATION_NAME: orgName,
    PROJECT_OR_NEED: subjectTopic || orgName,
  }).trim()

  const physical = String(config.physicalAddress || '').trim()

  const prospectLink = String(config.prospectLink || '').trim()

  const body_text = fillTemplate(TEMPLATES.default.body, {
    SALUTATION: interpretation.salutation || 'Hi team,',
    ORGANIZATION_NAME: orgName,
    OPENING_LINE: openingLine,
    ATTENTION_LINE: attentionLine,
    PROSPECT_LINK: prospectLink,
    OPT_OUT_LINE,
    PHYSICAL_ADDRESS: physical,
  })

  const body_html = textToHtml(body_text)

  const personalization = {
    template: 'default',
    subject_template: subjectTemplate,
    salutation: interpretation.salutation,
    contact_name: interpretation.contact?.name || null,
    contact_role: interpretation.contact?.role || null,
    contact_generic_address: !!interpretation.contact?.generic,
    organization_name: interpretation.organization_name,
    organization_type_framing: frameForType(interpretation.organization_type),
    evidence_topic: evidenceTopic,
    evidence_hook_phrase: hookPhrase,
    evidence_specific: signals.hasSpecific,
    evidence_signals: {
      has_mission: !!signals.mission,
      focus_areas: signals.focusAreas,
      program_areas: signals.programAreas,
      has_website_excerpt: !!signals.websiteExcerpt,
    },
    evidence_source_url: interpretation.evidence?.source || null,
    prospect_link: prospectLink || null,
    prospect_link_inserted: prospectLink.length > 0,
    physical_address_inserted: physical.length > 0,
    config_snapshot: {
      from_alias: config.fromAlias,
      reply_to: config.replyTo,
      display_name: config.displayName,
    },
  }

  return {
    ok: true,
    subject,
    body_text,
    body_html,
    recipient_email: recipientEmail,
    recipient_name: interpretation.contact?.name || null,
    recipient_role: interpretation.contact?.role || null,
    personalization,
  }
}
