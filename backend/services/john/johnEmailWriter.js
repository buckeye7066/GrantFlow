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

import { fillTemplate, pickSubjectTemplate, TEMPLATES, frameForType } from './johnEmailTemplates.js'
import { interpretLead } from './johnLeadInterpreter.js'
import { getJohnConfig } from './johnOutreachSafety.js'
import { aiComposerEnabled, composeEmailWithAI } from './johnEmailComposerAI.js'

const FALLBACK_TOPIC = 'community-focused funding work'

function deriveEvidenceTopic(interpretation) {
  const ev = interpretation?.evidence
  if (!ev) return FALLBACK_TOPIC
  const text = String(ev.text || '').trim()
  if (!text) return FALLBACK_TOPIC
  // Use the first 80 characters or up to first sentence boundary.
  const firstSentence = text.split(/[.!?]\s/)[0]
  const cut = firstSentence.length <= 80 ? firstSentence : firstSentence.slice(0, 80) + '\u2026'
  return cut
}

function deriveEvidenceDetail(interpretation) {
  const ev = interpretation?.evidence
  if (!ev) return null
  return String(ev.text || '').trim() || null
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

  const topic = deriveEvidenceTopic(interpretation)
  const detail = deriveEvidenceDetail(interpretation) || topic
  const recipientEmail = interpretation?.contact?.email || null

  const subjectTemplate = pickSubjectTemplate({
    organization_name: interpretation.organization_name,
    evidence_topic: topic,
  })

  const subject = fillTemplate(subjectTemplate, {
    ORGANIZATION_NAME: interpretation.organization_name || 'your organization',
    PROJECT_OR_NEED: topic,
  }).trim()

  const physical = String(config.physicalAddress || '').trim()

  const prospectLink = String(config.prospectLink || '').trim()

  const body_text = fillTemplate(TEMPLATES.default.body, {
    SALUTATION: interpretation.salutation || 'Hi team,',
    ORGANIZATION_NAME: interpretation.organization_name || 'your organization',
    EVIDENCE_TOPIC: topic,
    EVIDENCE_DETAIL: detail,
    PROSPECT_LINK: prospectLink,
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
    evidence_topic: topic,
    evidence_detail: detail,
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
