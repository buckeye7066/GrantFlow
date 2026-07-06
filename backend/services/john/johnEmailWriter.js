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
 *
 * Writing bar (this is the fallback when the AI path is unavailable, so it
 * must be excellent on its own): hook grounded in the org's OWN evidence,
 * a value proposition shaped by the funding lane that actually fits them
 * (fire departments hear about AFG-style equipment programs, food pantries
 * hear about food-security funders), a brief honest origin story, and one
 * crisp call-to-action. No filler, no generic flattery, no hype.
 */

import { fillTemplate, pickSubjectTemplate, TEMPLATES, frameForType, OPT_OUT_LINE, buildNoConflictParagraph } from './johnEmailTemplates.js'
import { DEFAULT_SALUTATION, interpretLead } from './johnLeadInterpreter.js'
import { getJohnConfig } from './johnOutreachSafety.js'
import { aiComposerEnabled, composeEmailWithAI } from './johnEmailComposerAI.js'
import { extractOrgSignals } from './johnEvidenceSufficiency.js'
import { matchFundingLane, DEFAULT_FUNDING_FRAME } from './johnFundingLanes.js'

/**
 * Build a clean, list-style noun phrase from Yana's focus/program areas (e.g.
 * "education and youth mentoring"). These are tag-like and read naturally
 * mid-sentence. Returns null when there are none — free-text/mission detail is
 * carried by the evidence hook instead (where a colon frame keeps it
 * grammatical), so the opening never says "looking into opened a saturday…".
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
  const clause = text.split(/[.!?;—–]\s/)[0].trim()
  return clause.length <= 60 ? clause : clause.slice(0, 60).trim() + '…'
}

/** Trim + punctuate a free-text evidence detail so a colon frame reads cleanly. */
function evidenceDetail(signals) {
  const detail = String(signals.hookText || '').trim()
  if (!detail) return null
  const trimmed = detail.length <= 200 ? detail : detail.slice(0, 200).trim() + '…'
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Compose the opening paragraph — the hook, grounded in the org's OWN
 * evidence whenever we have it. Priority:
 *   1. A specific free-text detail ("replacing 25-year-old SCBA gear") leads,
 *      framed by a colon so any grammatical shape reads cleanly, followed by
 *      the lane's sector observation so the empathy is specific, not generic.
 *   2. Clean focus/program tags ("food security and senior services").
 *   3. An honest generic opener — never fake specificity we don't have.
 */
function buildOpeningLine(orgName, signals, hookPhrase, lane) {
  const org = orgName || 'your organization'
  const detail = evidenceDetail(signals)
  const observation = lane?.observation ? ` ${lane.observation}` : ''
  if (detail) {
    return `One thing about ${org} stayed with me: ${detail}${observation} That is why I am writing.`
  }
  if (hookPhrase) {
    return `I came across ${org} while looking into ${hookPhrase}, and your work stood out enough that I wanted to reach out directly.${observation}`
  }
  return `I came across ${org} while looking for organizations whose mission tends to outrun their budget, and from what I can see, yours is doing real work that deserves to be funded.`
}

/**
 * A second paragraph that dwells on THE ORG'S OWN WORK (2026-07-06, owner
 * feedback: the notes "don't speak enough about what the potential client is
 * doing"). Built ONLY from facts Yana actually supplied — their mission in
 * their own words, and/or their focus/program areas — and omitted entirely
 * when we have nothing specific, so it can never pad with fake familiarity.
 */
function buildTheirWorkParagraph(orgName, signals, hookPhrase, detailUsedInOpening) {
  const org = orgName || 'your organization'
  const sentences = []

  const mission = String(signals.mission || '').trim()
  if (mission) {
    const trimmed = mission.length <= 220 ? mission : mission.slice(0, 220).trim() + '…'
    const quoted = trimmed.replace(/^"+|"+$/g, '')
    sentences.push(`Your own words say it better than I could: "${quoted}"`)
  }

  // Focus/program areas — skip when the opening already led with the same
  // phrase (hookPhrase without a specific detail), so we never repeat ourselves.
  if (hookPhrase && (detailUsedInOpening || mission)) {
    sentences.push(
      `Between ${hookPhrase}, ${org} is carrying real weight for the people you serve, and that kind of work almost never comes with a funding department behind it.`,
    )
  } else if (!hookPhrase && mission) {
    sentences.push(
      `Work like that is easy to admire and hard to fund, and it deserves better than hoping the right grant happens to come along.`,
    )
  }

  return sentences.length ? sentences.join(' ') : null
}

/**
 * Compose the value paragraph: what funding actually exists for an org like
 * this one (the lane), and what GrantFlow concretely does about it. When no
 * lane matches we stay honest and general rather than inventing a fit.
 */
function buildValueParagraph(orgName, hookPhrase, lane, detailUsedInOpening) {
  const org = orgName || 'your organization'
  const frame = lane || DEFAULT_FUNDING_FRAME
  const engine = `GrantFlow builds a funding profile of ${org} (mission, location, focus, eligibility), matches it against funding of exactly that kind, and then keeps every deadline, document, and application moving in one place so nothing slips.`
  if (lane) {
    const lead = hookPhrase && detailUsedInOpening
      ? `Work in ${hookPhrase} is usually funded through ${frame.categories}, and finding those programs is a job in itself.`
      : `Work like yours is usually funded through ${frame.categories}, and finding those programs is a job in itself.`
    return `${lead} ${engine}`
  }
  return `Here is the short version: GrantFlow builds a funding profile of ${org} (mission, location, focus areas, and eligibility) and matches that against ${frame.categories}. Then it keeps every deadline, document, and application moving in one place, so nothing slips through the cracks.`
}

/** One crisp, self-serve call-to-action: talk to Anya, get a live scan. */
function buildCtaParagraph(orgName) {
  const org = orgName || 'your organization'
  return `You should not have to take my word for any of this. The link below opens a short conversation with Anya, our assistant. Tell her about ${org} and she will run a live scan of funding that fits, no account or commitment needed just to look. If what comes back looks worth your time, you can take the next step from there:`
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
  const lane = matchFundingLane(lead, signals)
  const orgName = interpretation.organization_name || 'your organization'
  const hookPhrase = deriveHookPhrase(signals)
  const evidenceTopic = deriveEvidenceTopic(signals, hookPhrase)
  const detail = evidenceDetail(signals)
  const openingHook = buildOpeningLine(interpretation.organization_name, signals, hookPhrase, lane)
  const theirWork = buildTheirWorkParagraph(interpretation.organization_name, signals, hookPhrase, !!detail)
  // The opening SLOT carries both paragraphs (hook + their-work) so the
  // template shape stays fixed and the safety surface unchanged.
  const openingLine = theirWork ? `${openingHook}\n\n${theirWork}` : openingHook
  const valueParagraph = buildValueParagraph(interpretation.organization_name, hookPhrase, lane, !!detail)
  const ctaParagraph = buildCtaParagraph(interpretation.organization_name)
  const recipientEmail = interpretation?.contact?.email || null

  // Subject: prefer the lane-specific form ("Fire and EMS grant options for
  // <Org>") — personal, specific, and honest. Otherwise steer toward the
  // "Quick note about <topic>" form only when we have a genuinely specific,
  // short hook, so we never ship "Quick note about community-focused funding
  // work". Final fallback is the org-name subject.
  const subjectTopic = evidenceTopic && evidenceTopic.length <= 50 ? evidenceTopic : null
  const subjectTemplate = pickSubjectTemplate({
    organization_name: interpretation.organization_name,
    evidence_topic: subjectTopic,
    funding_lane_subject: lane?.subjectLead || null,
  })

  const subject = fillTemplate(subjectTemplate, {
    ORGANIZATION_NAME: orgName,
    PROJECT_OR_NEED: subjectTopic || orgName,
    FUNDING_LANE_SUBJECT: lane?.subjectLead || '',
  }).trim()

  const physical = String(config.physicalAddress || '').trim()

  const prospectLink = String(config.prospectLink || '').trim()
  // Prefer Yana's real contact greeting (name/role); when none is known a bare
  // "Hello," reads cold, so fall back to a warm, org-specific greeting.
  const salutation = (interpretation.salutation && interpretation.salutation !== DEFAULT_SALUTATION)
    ? interpretation.salutation
    : (orgName && orgName !== 'your organization' ? `Hello ${orgName} team,` : 'Hello there,')

  const body_text = fillTemplate(TEMPLATES.default.body, {
    SALUTATION: salutation,
    ORGANIZATION_NAME: orgName,
    OPENING_LINE: openingLine,
    VALUE_PARAGRAPH: valueParagraph,
    NO_CONFLICT_PARAGRAPH: buildNoConflictParagraph(interpretation.organization_name),
    CTA_PARAGRAPH: ctaParagraph,
    PROSPECT_LINK: prospectLink,
    OPT_OUT_LINE,
    PHYSICAL_ADDRESS: physical,
  })

  const body_html = textToHtml(body_text)

  const personalization = {
    template: 'default',
    subject_template: subjectTemplate,
    salutation,
    contact_name: interpretation.contact?.name || null,
    contact_role: interpretation.contact?.role || null,
    contact_generic_address: !!interpretation.contact?.generic,
    organization_name: interpretation.organization_name,
    organization_type: interpretation.organization_type || null,
    organization_type_framing: frameForType(interpretation.organization_type),
    funding_lane: lane?.key || null,
    funding_lane_categories: lane?.categories || null,
    evidence_topic: evidenceTopic,
    evidence_hook_phrase: hookPhrase,
    evidence_specific: signals.hasSpecific,
    their_work_paragraph_included: !!theirWork,
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
