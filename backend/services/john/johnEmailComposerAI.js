/**
 * John — AI email composer.
 *
 * Upgrades John's outreach from a fixed template to genuinely personalized,
 * MBA-quality copy that (1) speaks to the organization's actual mission /
 * accomplishments / goals, (2) explains what GrantFlow is, and (3) explains how
 * GrantFlow can specifically help that org.
 *
 * Safety first — this never weakens John's guarantees:
 *   - The model writes only the personalized OPENING + body. The compliant
 *     footer (signature, opt-out line, postal address) is appended by code, so
 *     CAN-SPAM elements are always present verbatim regardless of model output.
 *   - The result is pre-validated against the SAME classifiers the draft service
 *     enforces (classifySubject / classifyBody). If the model trips any rule
 *     (funding guarantees, fake prior relationship, predatory/deceptive), or the
 *     API is unavailable, the caller falls back to the deterministic template.
 *   - The model is told to use ONLY the supplied facts and never invent specific
 *     accomplishments, dollar figures, or relationships.
 *
 * Returns the same shape as the template composer, or { ok: false } so the
 * caller can fall back.
 */

import {
  classifyBody,
  classifySubject,
  getJohnConfig,
} from './johnOutreachSafety.js'
import { interpretLead } from './johnLeadInterpreter.js'
import { researchOrganization } from './johnOrgResearch.js'

const GRANTFLOW_FACTS = [
  'GrantFlow is a funding discovery and application-tracking platform.',
  'It builds a profile of an organization (mission, location, needs, eligibility) and matches it to grants, scholarships, benefits, foundation programs, and other funding sources that actually fit.',
  'It then helps track deadlines, documents, and application progress in one place.',
  'It is built for churches, nonprofits, schools, volunteer fire departments, ministries, families, students, and small organizations, the kind of groups that rarely have a dedicated grant writer.',
  'Founder: Dr. John White (Axiom BioLabs).',
  'Origin (true, may be shared honestly): Dr. White first built GrantFlow to find funding for his own research lab, Axiom BioLabs; he then found the same engine helped the mission and nonprofit work he cares about, and helped him find scholarships and college-endowment opportunities for his own children.',
].join(' ')

function aiModel(config) {
  return (
    process.env.JOHN_AI_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    'claude-sonnet-4-6'
  )
}

export function aiComposerEnabled(config = getJohnConfig()) {
  if (String(process.env.JOHN_AI_DRAFTING || '').toLowerCase() === 'off') return false
  return !!String(process.env.ANTHROPIC_API_KEY || '').trim()
}

let cachedClient = null
async function getClient() {
  if (cachedClient) return cachedClient
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  cachedClient = new Anthropic({
    apiKey: key,
    timeout: Number(process.env.JOHN_AI_TIMEOUT_MS || 25_000),
    maxRetries: Number(process.env.JOHN_AI_MAX_RETRIES || 1),
  })
  return cachedClient
}

/** Pull the structured, factual hooks Yana attached to the lead. */
function extractOrgFacts(lead) {
  const evidence = Array.isArray(lead?.public_evidence) ? lead.public_evidence : []
  const facts = { mission: null, focus_areas: [], program_areas: [], revenue: null, assets: null, website_excerpt: null }
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'mission_statement' && e.text) facts.mission = String(e.text)
    else if (e.type === 'focus_areas' && Array.isArray(e.value)) facts.focus_areas = e.value
    else if (e.type === 'program_areas' && Array.isArray(e.value)) facts.program_areas = e.value
    else if (e.type === 'irs_990_financials') {
      if (e.revenue !== null && e.revenue !== undefined) facts.revenue = e.revenue
      if (e.assets !== null && e.assets !== undefined) facts.assets = e.assets
    } else if (e.type === 'website_excerpt' && e.text) {
      facts.website_excerpt = String(e.text).slice(0, 1500)
    }
  }
  return facts
}

/**
 * The closing block, appended by code after the model's personalized body.
 *
 * This is where the call-to-action lives: instead of John offering to run a
 * scan, we invite the recipient to try GrantFlow themselves — talk to Anya,
 * get a live funding scan, and only then decide whether to sign up. The link
 * (config.prospectLink → the frontend /start funnel), signature, opt-out line,
 * and postal address are all emitted deterministically so CAN-SPAM elements and
 * the correct URL are always present verbatim regardless of model output.
 */
function buildFooter(config, organizationName) {
  const physical = String(config.physicalAddress || '').trim()
  const link = String(config.prospectLink || '').trim()
  const org = String(organizationName || '').trim() || 'your organization'
  return [
    '',
    `Rather than just describe it, I’d like you to see it for yourself. You can talk through your work with Anya, our assistant, and she’ll pull a live scan of funding sources that fit ${org}, with no account or commitment needed. If what comes back is useful, you can choose to create an account from there:`,
    ...(link ? ['', link] : []),
    '',
    'Respectfully,',
    '',
    'Dr. John White',
    'GrantFlow / Axiom BioLabs',
    String(config.replyTo || 'Ellie@axiombiolabs.org'),
    '',
    'If this is not relevant, you can reply "no thanks" and I will not follow up.',
    ...(physical ? ['', physical] : []),
  ].join('\n')
}

function htmlEscape(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function textToHtml(text) {
  const paragraphs = htmlEscape(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
  return `<!doctype html><html><body>${paragraphs.join('')}</body></html>`
}

function buildPrompt(lead, interpretation, facts, config, researchSummary = '') {
  const org = interpretation.organization_name || 'the organization'
  const ctx = {
    organization_name: org,
    organization_type: interpretation.organization_type || lead?.organization_type || null,
    location: interpretation.location || lead?.location || null,
    mission: facts.mission,
    focus_areas: facts.focus_areas,
    program_areas: facts.program_areas,
    annual_revenue: facts.revenue,
    total_assets: facts.assets,
    website: lead?.website_url || null,
    website_excerpt: facts.website_excerpt,
    grantflow_fit: interpretation.grantflow_fit_summary || lead?.grantflow_fit_summary || null,
    // What we found about this org on the live web (titles + snippets only).
    // Empty when web research is unavailable — the prompt then omits it.
    web_research: researchSummary ? String(researchSummary) : null,
    recipient_first_name:
      interpretation.salutation && /^Hi\s+(\w+),/.test(interpretation.salutation)
        ? interpretation.salutation.match(/^Hi\s+(\w+),/)[1]
        : null,
  }
  const system = [
    'You are Dr. John White, founder of GrantFlow, MBA, and a working scientist who has had to raise money for his own lab. You are writing a short, personable cold-outreach email to an organization you have NOT spoken with before. Write the way a sharp, generous peer writes: warm, plain-spoken, specific, and a little human. Never like a marketing template.',
    '',
    `About GrantFlow (use these facts, do not contradict them): ${GRANTFLOW_FACTS}`,
    '',
    'Address a PERSON, not a list. If you were given a recipient/contact name, the body must read as if written to that individual. Only fall back to a generic greeting when no person is known. Never write "Hi Team" when you have a name.',
    '',
    'The email body MUST, in this order:',
    '1. LEAD WITH THEM. Spend the FIRST ONE TO TWO PARAGRAPHS genuinely on what THIS organization (and this person) is doing: their mission, the specific programs/work/population they serve, and why it matters, drawn from the supplied facts and web_research (what we found about them on the public web). This is the heart of the email and must make it unmistakable the note was written for them, not blasted to a list. Be specific and warm, like someone who actually looked into their work and respects it. Use ONLY facts present in the supplied data (including web_research snippets); NEVER invent achievements, dollar figures, programs, names, or events, and do not treat a web_research snippet as more certain than it is. If the facts are genuinely thin, write honestly and specifically about their sector and the kind of work they appear to do, rather than padding with vague praise.',
    '2. BRIDGE. Transition naturally from their work into who you are and what GrantFlow is, with its honest origin in 1-2 sentences: you first built GrantFlow to find funding for your own research lab (Axiom BioLabs), then found the same engine helped the mission and nonprofit work you care about, and even helped you find scholarships and college funding for your own children. A touch of self-deprecation is welcome ("I did not set out to build software").',
    '3. Explain concretely how GrantFlow can help THIS organization given the specific mission/work/needs you named in step 1. Tie it directly back to them. Be specific, never generic.',
    '',
    'Voice and craft (warm, MBA-level peer outreach):',
    '- Sound like a sharp, generous, well-read peer writing one real person a thoughtful note, not a brochure. Warm, articulate, and confident without being formal or stiff.',
    '- The opening must feel earned and personal: show you understand their work before you ever mention yourself. Lead with curiosity and respect for them, not with your pitch.',
    '- Be concrete. If you cannot say something specific, say something honest and brief rather than filler. Do not repeat a word or phrase awkwardly, and do not stack adjectives.',
    '',
    'Hard rules (a violation makes the email unusable):',
    '- Do NOT promise, guarantee, or imply guaranteed funding/approval.',
    '- Do NOT claim any prior relationship, meeting, or conversation.',
    '- Do NOT use urgency, pressure, scarcity, or "act now" language.',
    '- No hype, no exclamation-heavy marketing voice. Credible, peer-to-peer, respectful.',
    '- Do NOT use em-dashes or en-dashes (— or –) anywhere. Use commas, periods, parentheses, or a colon instead.',
    '- 200-300 words for the body (enough for one to two real paragraphs about them, then the bridge and how GrantFlow helps). Plain text with paragraph breaks.',
    '- Do NOT write a call to action, an offer to run a scan, a link, a signature, a sign-off, an opt-out line, or a postal address. ALL of those are added separately by the system. End immediately after explaining how GrantFlow can help this organization (step 3).',
    '- Write a subject line that is specific and non-deceptive. Do NOT start with "Re:" or "Urgent", and never use the words guaranteed, approved, or congratulations.',
    '',
    'Return ONLY a JSON object: {"subject": "...", "body": "..."} with no markdown, no commentary.',
  ].join('\n')
  const user = `Organization facts (JSON):\n${JSON.stringify(ctx, null, 2)}\n\nWrite the email now as JSON {"subject","body"}.`
  return { system, user }
}

/**
 * Hard guarantee that no em-dash or en-dash survives into a sent email, even if
 * the model ignores the prompt rule. A dash used as a pause/parenthetical reads
 * cleanly as a comma; we then tidy any doubled commas or space-before-comma the
 * substitution can introduce.
 */
function stripDashes(text) {
  return String(text || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
}

function parseJsonObject(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

/**
 * Compose a personalized email via the LLM. Returns the same shape as the
 * template composer, or { ok: false } when AI is unavailable or the output
 * fails John's own safety classifiers (caller then falls back to template).
 */
export async function composeEmailWithAI(lead, opts = {}) {
  const config = opts.config || getJohnConfig()
  const interpretation = opts.interpretation || interpretLead(lead)
  const logger = opts.logger

  const client = await getClient()
  if (!client) return { ok: false, reason: 'no_api_key' }

  const facts = extractOrgFacts(lead)

  // Pre-draft web research: look the org up on the live web and feed the
  // findings into the prompt. Failure-tolerant + time-bounded — if search is
  // unavailable or returns nothing, research is empty and John drafts anyway.
  const research = await researchOrganization({
    orgName: interpretation.organization_name || lead?.organization_name,
    location: interpretation.location || lead?.location,
    logger,
  })

  const { system, user } = buildPrompt(lead, interpretation, facts, config, research.summary)

  let raw
  try {
    const resp = await client.messages.create({
      model: aiModel(config),
      max_tokens: 800,
      temperature: 0.6,
      system,
      messages: [{ role: 'user', content: user }],
    })
    raw = (Array.isArray(resp?.content) ? resp.content : [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n')
      .trim()
  } catch (err) {
    logger?.warn?.('[John] AI composer API error', { error: err?.message })
    return { ok: false, reason: 'api_error', error: err?.message }
  }

  const parsed = parseJsonObject(raw)
  if (!parsed || !parsed.subject || !parsed.body) {
    return { ok: false, reason: 'unparseable_output' }
  }

  let subject = stripDashes(String(parsed.subject).replace(/\s+/g, ' ').trim()).slice(0, 180)
  const aiBody = stripDashes(String(parsed.body).trim())

  // Greeting: prefer the model's own opening only if it greets; otherwise lead
  // with the interpreter's safe salutation.
  const hasGreeting = /^(hi|hello|dear|greetings)\b/i.test(aiBody)
  const salutation = interpretation.salutation || 'Hi team,'
  const composedBody = (hasGreeting ? aiBody : `${salutation}\n\n${aiBody}`) + '\n' + buildFooter(config, interpretation.organization_name)

  // Pre-validate against the SAME gates the draft service enforces, so we never
  // hand the safety layer something it will block — fall back to template instead.
  const subjCheck = classifySubject(subject)
  if (!subjCheck.ok) {
    subject = `Possible funding help for ${interpretation.organization_name || 'your organization'}`
  }
  const bodyCheck = classifyBody(composedBody, {
    physicalAddress: config.physicalAddress,
    requirePhysicalAddress: config.physicalAddressRequired,
  })
  if (!bodyCheck.ok) {
    logger?.warn?.('[John] AI body failed safety, falling back to template', { reasons: bodyCheck.reasons })
    return { ok: false, reason: 'failed_safety', reasons: bodyCheck.reasons }
  }

  return {
    ok: true,
    subject,
    body_text: composedBody,
    body_html: textToHtml(composedBody),
    recipient_email: interpretation?.contact?.email || null,
    recipient_name: interpretation?.contact?.name || null,
    recipient_role: interpretation?.contact?.role || null,
    personalization: {
      template: 'ai_v1',
      model: aiModel(config),
      salutation,
      contact_name: interpretation.contact?.name || null,
      contact_role: interpretation.contact?.role || null,
      organization_name: interpretation.organization_name,
      facts_used: {
        mission: facts.mission,
        focus_areas: facts.focus_areas,
        has_financials: facts.revenue !== null || facts.assets !== null,
        has_website_excerpt: !!facts.website_excerpt,
      },
      web_research: {
        query: research.query || null,
        used: !!research.summary,
        result_count: Array.isArray(research.results) ? research.results.length : 0,
        summary: research.summary || null,
        source_urls: Array.isArray(research.results)
          ? research.results.map((r) => r?.url).filter(Boolean)
          : [],
      },
      prospect_link: String(config.prospectLink || '').trim() || null,
      config_snapshot: {
        from_alias: config.fromAlias,
        reply_to: config.replyTo,
        display_name: config.displayName,
      },
    },
  }
}
