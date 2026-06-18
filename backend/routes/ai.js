import express from 'express';
import { fetchReminderSnapshot } from './reminders.js';
import { buildReminderPlanPrompt } from '../prompts/reminderPlan.js';
import { extractCompletionText } from '../utils/openai.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { formatError } from '../middleware/errorHandler.js';
import { validatePagination } from '../utils/validation.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_TIMEOUT_MS, MAX_PROMPT_LENGTH } from '../config/constants.js';
// Non-authoritative scoring helper. Used ONLY for display-only ranking in the
// AI chat context; this route does NOT insert into the grants pipeline and
// does NOT make accept/reject decisions. computeMatchDecision() remains the
// sole acceptance authority. We alias scoreOpportunity to keep the call sites
// compatible while moving off the legacy matchingEngine.js shim.
import { scoreOpportunity as calculateMatchScore } from '../services/matchEngine.js';
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js';
import { DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, FALLBACK_TOP_N } from '../config/matchThresholds.js';
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js';
import { buildSchoolLookupFallbackData } from '../services/schoolLookupFallback.js'
import { enforceTierCapability } from '../middleware/entitlements.js'
import { TIER_CAPABILITIES } from '../utils/tierGating.js'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  isAdminUser,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:ai')

const router = express.Router();

// All AI endpoints are authenticated; these endpoints can expose profile/org/grant context.
router.use((req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  return next()
})

function getOpenAI() {
  return createOpenAIClient().openai;
}

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai;
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
      maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
    })
  } catch (err) {
    console.warn('[ai] Anthropic client unavailable:', err?.message || String(err))
    return null
  }
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function fallbackProposalTemplate({ grant, section }) {
  const applicant = grant?.name || 'Applicant'
  const funder = grant?.funder || 'Funder'
  const title = grant?.title || 'Grant Opportunity'
  const focus = section || 'project narrative'
  // Honest fallback: explicitly tell the user the AI generation failed and
  // give them a checklist of what they need to write themselves, rather than
  // bracket-placeholders that look like a half-complete proposal.
  return [
    `AI generation unavailable — manual draft required for ${focus}.`,
    '',
    `Applicant: ${applicant}`,
    `Grant: ${title}`,
    `Funder: ${funder}`,
    '',
    'The AI service is currently unavailable, so this draft could not be generated.',
    'Please write each section yourself using your real profile information:',
    '',
    '  1) Need / Problem — the specific community need and who is impacted',
    '  2) Project Overview — what you will do, where, and for whom',
    '  3) Activities & Timeline — 3–6 key activities with target dates',
    '  4) Outcomes & Measurement — measurable outcomes and how you will track them',
    '  5) Budget & Sustainability — how funds will be used and how work continues after funding',
    '',
    'Try again in a few minutes, or contact support if the issue persists.',
    '',
  ].join('\n')
}

function tryExtractFirstJson(text) {
  const raw = String(text || '')
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  return safeParseJSON(jsonMatch ? jsonMatch[0] : raw, null)
}

function compactJson(value, maxLen = 2800) {
  let text = ''
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value ?? '')
  }
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`
}

async function invokeTextWithFallback({ model, system, prompt, temperature, maxTokens }) {
  const openai = getOpenAIOptional()
  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: model || DEFAULT_OPENAI_MODEL,
        messages: system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }],
        temperature: typeof temperature === 'number' ? temperature : 0.3,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 1200,
      })
      return { text: extractCompletionText(completion), provider: 'openai', usage: completion.usage ?? null }
    } catch (error) {
      const summary = summarizeOpenAIError(error)
      console.warn('[ai] OpenAI failed, will try Anthropic:', summary?.message || error?.message || error)
    }
  }

  const anthropic = await createAnthropicClient()
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 1200,
        temperature: typeof temperature === 'number' ? temperature : 0.3,
        system: system || undefined,
        messages: [{ role: 'user', content: prompt }],
      })
      return { text: extractAnthropicText(response), provider: 'anthropic', usage: null }
    } catch (error) {
      console.warn('[ai] Anthropic failed:', error?.message || error)
    }
  }

  return { text: null, provider: 'fallback', usage: null }
}

// Match opportunities to a profile
// Comprehensive match endpoint for discovery
router.post('/comprehensive-match', async (req, res) => {
  try {
    const { profile, profile_id } = req.body
    
    const isPostgres = req.db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'

    // Profile isolation: only global catalog + this profile's own crawl results
    const profileIdForIsolation = profile_id || profile?.id || null
    const isolationClause = profileIdForIsolation
      ? 'AND (profile_id IS NULL OR profile_id = ?)'
      : 'AND profile_id IS NULL'
    const isolationParams = profileIdForIsolation ? [profileIdForIsolation] : []

    const opportunities = await req.db.prepare(`
      SELECT * FROM funding_opportunities
      WHERE is_active = ${activeVal}
      AND ${trustedOriginClause()} AND ${trustedSourceClause()}
      ${isolationClause}
      ORDER BY created_at DESC
      LIMIT 500
    `).all(...isolationParams)

    // Calculate match scores using deterministic algorithm
    const scoredOpps = opportunities.map(opp => {
      const matchResult = calculateMatchScore(profile, opp);
      return {
        ...opp,
        fit_score: matchResult.score,
        match_reasons: matchResult.reasons
      };
    });

    // Zero-result fallback: progressively lower threshold so users never see empty results
    // when relevant funding likely exists.
    let matchThreshold = DEFAULT_MIN_SCORE
    let matched = scoredOpps.filter(o => o.fit_score >= matchThreshold)
    if (matched.length === 0 && scoredOpps.length > 0) {
      for (const fallback of RELAX_THRESHOLDS) {
        matched = scoredOpps.filter(o => o.fit_score >= fallback)
        if (matched.length > 0) {
          matchThreshold = fallback
          break
        }
      }
      if (matched.length === 0) {
        matched = scoredOpps.slice(0, FALLBACK_TOP_N)
        matchThreshold = 0
      }
    }
    matched.sort((a, b) => b.fit_score - a.fit_score)

    res.json({
      opportunities: matched,
      total: scoredOpps.length,
      threshold_used: matchThreshold,
      threshold_relaxed: matchThreshold < DEFAULT_MIN_SCORE ? true : undefined,
      profile
    })
  } catch (error) {
    routeLogger.error('Comprehensive match error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ECF service search endpoint — returns real DB entries for this profile's state
router.post('/ecf-service-search', async (req, res) => {
  try {
    const { profile, profile_id } = req.body

    const isPostgresEcf = req.db?.dialect === 'postgres'
    const activeEcf = isPostgresEcf ? 'TRUE' : '1'

    // Profile isolation
    const isolationId = profile_id || profile?.id || null
    const isolationClause = isolationId
      ? 'AND (profile_id IS NULL OR profile_id = ?)'
      : 'AND profile_id IS NULL'
    const isolationParams = isolationId ? [isolationId] : []

    // State filter from profile
    const profileState = profile?.state || null
    const stateClause = profileState
      ? `AND (state = ? OR state IS NULL OR state = 'nationwide')`
      : ''
    const stateParams = profileState ? [profileState] : []

    const services = await req.db.prepare(`
      SELECT * FROM funding_opportunities
      WHERE is_active = ${activeEcf}
        AND ${trustedOriginClause()} AND ${trustedSourceClause()}
        ${isolationClause}
        ${stateClause}
        AND (
          LOWER(categories) LIKE '%ecf%'
          OR LOWER(categories) LIKE '%waiver%'
          OR LOWER(categories) LIKE '%home and community%'
          OR LOWER(title) LIKE '%choices%'
          OR LOWER(source) LIKE '%ecf%'
        )
      ORDER BY updated_at DESC
      LIMIT 50
    `).all(...isolationParams, ...stateParams)

    // Score each service against the profile using keyword matching
    const scored = services.map(svc => {
      const matchResult = calculateMatchScore(profile || {}, svc)
      return { ...svc, match_score: matchResult.score, match_reasons: matchResult.reasons }
    }).sort((a, b) => b.match_score - a.match_score)

    res.json({
      services: scored,
      total: scored.length,
      profile
    })
  } catch (error) {
    routeLogger.error('ECF service search error:', error)
    res.status(500).json({ error: error.message })
  }
})

router.post('/match', async (req, res) => {
  try {
    const { profile_id } = req.body;
    const { limit } = validatePagination({ limit: req.body.limit || 50 });
    
    if (!profile_id) {
      return res.status(400).json({ error: 'profile_id is required' });
    }

    if (!(await ensureOrganizationAccess(req, res, String(profile_id)))) return
    
    // Get the organization profile
    const profile = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    const isPostgresMatch = req.db?.dialect === 'postgres'
    const activeMatch = isPostgresMatch ? 'TRUE' : '1'

    // Profile isolation: only global catalog + this profile's own crawl results
    const profileIdForIsolation = profile_id || profile?.id || null
    const isolationClause = profileIdForIsolation
      ? 'AND (profile_id IS NULL OR profile_id = ?)'
      : 'AND profile_id IS NULL'

    let query = `
      SELECT * FROM funding_opportunities 
      WHERE is_active = ${activeMatch}
      AND ${trustedOriginClause()} AND ${trustedSourceClause()}
      AND (is_national = ${activeMatch} OR state = ? OR state IS NULL)
      ${isolationClause}
    `;
    const params = profileIdForIsolation ? [profile.state, profileIdForIsolation] : [profile.state];
    
    // Filter by deadline (not expired)
    query += ` AND (deadline >= CURRENT_DATE OR deadline IS NULL OR deadline_type = 'rolling')`;
    
    query += ' ORDER BY deadline ASC NULLS LAST LIMIT ?';
    params.push(limit * 2); // Get more than needed for AI scoring
    
    const opportunities = await req.db.prepare(query).all(...params);
    
    if (opportunities.length === 0) {
      return res.json({ opportunities: [], count: 0, profile_id });
    }
    
    // Canonical scoring ONLY. matchEngine.scoreOpportunity (imported as
    // calculateMatchScore) is the sole match authority — this route previously
    // hand-rolled a keyword scorer with a hardcoded 50-point base + ad-hoc
    // bonuses, which is a forbidden competing match authority (mission Goals
    // 6 & 7). We now delegate to the canonical engine and use the canonical
    // threshold config instead of a hardcoded number.
    const scoredOpportunities = opportunities.map(opp => {
      const matchResult = calculateMatchScore(profile, opp);
      return {
        ...opp,
        eligibility_bullets: safeParseJSON(opp.eligibility_bullets, []),
        categories: safeParseJSON(opp.categories, []),
        keywords: safeParseJSON(opp.keywords, []),
        match_score: matchResult.score,
        match_reasons: Array.isArray(matchResult.reasons) ? matchResult.reasons.slice(0, 5) : [],
      };
    });

    // Sort by canonical score and limit (threshold from canonical config).
    const topMatches = scoredOpportunities
      .filter(o => o.match_score >= DEFAULT_MIN_SCORE)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, limit);
    
    res.json({
      opportunities: topMatches,
      count: topMatches.length,
      profile_id,
      profile_state: profile.state
    });
    
  } catch (error) {
    console.error('Error matching opportunities:', error);
    res.status(500).json(formatError(error));
  }
});

// AI-enhanced matching using OpenAI
router.post('/match/ai', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { profile_id, opportunity_ids } = req.body;
    const { limit } = validatePagination({ limit: req.body.limit || 20 });
    
    const openai = getOpenAIOptional();
    
    // Get the profile
    if (!profile_id) {
      return res.status(400).json({ error: 'profile_id is required' })
    }
    if (!(await ensureOrganizationAccess(req, res, String(profile_id)))) return
    const profile = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // Get opportunities (either specific ones or top matches)
    let opportunities;

    // Profile isolation: only global catalog + this profile's own crawl results
    const profileIdForIsolation = profile_id || profile?.id || null
    const isolationClause = profileIdForIsolation
      ? 'AND (profile_id IS NULL OR profile_id = ?)'
      : 'AND profile_id IS NULL'
    const isolationParams = profileIdForIsolation ? [profileIdForIsolation] : []

    if (opportunity_ids && opportunity_ids.length > 0) {
      const placeholders = opportunity_ids.map(() => '?').join(',');
      const isPgIds = req.db?.dialect === 'postgres'
      const actIds = isPgIds ? 'TRUE' : '1'
      opportunities = await req.db.prepare(`
        SELECT * FROM funding_opportunities
        WHERE id IN (${placeholders})
          AND is_active = ${actIds}
          AND ${trustedOriginClause()} AND ${trustedSourceClause()}
          ${isolationClause}
      `).all(...opportunity_ids, ...isolationParams);
    } else {
      const isPg = req.db?.dialect === 'postgres'
      const actVal = isPg ? 'TRUE' : '1'
      opportunities = await req.db.prepare(`
        SELECT * FROM funding_opportunities 
        WHERE is_active = ${actVal}
        AND ${trustedOriginClause()} AND ${trustedSourceClause()}
        AND (is_national = ${actVal} OR state = ? OR state IS NULL)
        AND (deadline >= CURRENT_DATE OR deadline IS NULL OR deadline_type = 'rolling')
        ${isolationClause}
        LIMIT ?
      `).all(profile.state, ...isolationParams, limit * 2);
    }
    
    if (opportunities.length === 0) {
      return res.json({ opportunities: [], count: 0 });
    }
    
    // Prepare profile summary for AI
    const profileSummary = {
      type: profile.applicant_type,
      state: profile.state,
      keywords: safeParseJSON(profile.keywords, []),
      focus_areas: safeParseJSON(profile.focus_areas, []),
      veteran: profile.veteran,
      disabled: profile.disabled,
      first_generation: profile.first_generation,
      low_income: profile.snap_recipient || profile.ssi_recipient,
      mission: profile.mission,
      funding_needed: profile.funding_amount_needed
    };
    
    // Prepare opportunities summary
    const oppsSummary = opportunities.slice(0, 15).map(o => ({
      id: o.id,
      title: o.title,
      sponsor: o.sponsor,
      description: (o.description || '').substring(0, 500),
      eligibility: safeParseJSON(o.eligibility_bullets, []).slice(0, 5),
      amount: o.amount_max ? `Up to $${o.amount_max}` : 'Varies',
      deadline: o.deadline
    }));
    
    const prompt = `You are a grant matching expert. Score how well each opportunity matches this applicant profile.

APPLICANT PROFILE:
${JSON.stringify(profileSummary, null, 2)}

OPPORTUNITIES TO SCORE:
${JSON.stringify(oppsSummary, null, 2)}

For each opportunity, return a JSON object with:
- id: the opportunity id
- score: 0-100 match score
- reasons: array of 2-4 specific reasons for the score

Return ONLY valid JSON in this format:
{
  "matches": [
    { "id": "...", "score": 85, "reasons": ["Reason 1", "Reason 2"] }
  ]
}`;

    let aiResults;
    try {
      let rawText = null
      if (openai) {
        const completion = await openai.chat.completions.create({
          model: DEFAULT_OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
        });
        rawText = extractCompletionText(completion)
      } else {
        const anthropic = await createAnthropicClient()
        if (anthropic) {
          const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
            max_tokens: 2000,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }],
          })
          rawText = extractAnthropicText(response)
        }
      }

      aiResults = tryExtractFirstJson(rawText)
      if (!aiResults) throw new Error('Failed to parse AI response');
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      // Fall back to basic matching
      return res.json({
        opportunities: opportunities.slice(0, limit).map(o => ({
          ...o,
          match_score: 50,
          match_reasons: ['AI scoring unavailable - basic match']
        })),
        count: Math.min(opportunities.length, limit),
        ai_enhanced: false
      });
    }
    
    // Merge AI scores with opportunity data
    const scoredOpps = opportunities.map(opp => {
      const aiMatch = aiResults.matches?.find(m => m.id === opp.id);
      return {
        ...opp,
        eligibility_bullets: safeParseJSON(opp.eligibility_bullets, []),
        categories: safeParseJSON(opp.categories, []),
        keywords: safeParseJSON(opp.keywords, []),
        match_score: aiMatch?.score || 50,
        match_reasons: aiMatch?.reasons || ['Geographic match']
      };
    });
    
    const topMatches = scoredOpps
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, limit);
    
    res.json({
      opportunities: topMatches,
      count: topMatches.length,
      ai_enhanced: true
    });
    
  } catch (error) {
    console.error('Error in AI matching:', error);
    res.status(500).json(formatError(error));
  }
});

// Generate proposal content
router.post('/generate/proposal', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { grant_id, section, prompt: userPrompt } = req.body;

    if (!grant_id) {
      return res.status(400).json({ error: 'grant_id is required' })
    }
    const grantAccess = await ensureGrantAccess(req, res, String(grant_id))
    if (!grantAccess) return
    
    // Get grant details
    const grant = await req.db.prepare(`
      SELECT 
        g.*,
        o.name AS organization_name,
        o.applicant_type AS organization_applicant_type,
        o.mission AS organization_mission,
        o.city AS organization_city,
        o.state AS organization_state,
        o.website AS organization_website,
        fo.id AS opportunity_id,
        fo.title AS opportunity_title,
        fo.sponsor AS opportunity_sponsor,
        fo.description AS opportunity_description,
        fo.deadline AS opportunity_deadline,
        fo.deadline_type AS opportunity_deadline_type,
        fo.state AS opportunity_state,
        fo.is_national AS opportunity_is_national,
        fo.amount_min AS opportunity_amount_min,
        fo.amount_max AS opportunity_amount_max,
        fo.amount_description AS opportunity_amount_description,
        fo.application_url AS opportunity_application_url,
        fo.eligibility_bullets AS opportunity_eligibility_bullets,
        fo.categories AS opportunity_categories,
        fo.keywords AS opportunity_keywords,
        fo.requires_501c3 AS opportunity_requires_501c3,
        fo.requires_match AS opportunity_requires_match,
        fo.match_percentage AS opportunity_match_percentage
      FROM grants g
      JOIN organizations o ON g.organization_id = o.id
      LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
      WHERE g.id = ?
    `).get(grant_id);
    
    if (!grant) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    
    const applicantContext = {
      name: grant.organization_name ?? grant.name ?? null,
      applicant_type: grant.organization_applicant_type ?? grant.applicant_type ?? null,
      mission: grant.organization_mission ?? grant.mission ?? null,
      location: {
        city: grant.organization_city ?? null,
        state: grant.organization_state ?? null,
      },
      website: grant.organization_website ?? null,
      grant_tracking: {
        grant_id: grant.id,
        status: grant.status ?? null,
        amount_requested: grant.amount_requested ?? null,
        deadline: grant.deadline ?? null,
        notes: grant.notes ?? null,
      },
    }

    const opportunityContext = grant.opportunity_id
      ? {
          id: grant.opportunity_id,
          title: grant.opportunity_title ?? null,
          sponsor: grant.opportunity_sponsor ?? null,
          description: grant.opportunity_description ?? null,
          deadline: grant.opportunity_deadline ?? null,
          deadline_type: grant.opportunity_deadline_type ?? null,
          geography: {
            is_national: grant.opportunity_is_national ?? null,
            state: grant.opportunity_state ?? null,
          },
          funding: {
            amount_min: grant.opportunity_amount_min ?? null,
            amount_max: grant.opportunity_amount_max ?? null,
            amount_description: grant.opportunity_amount_description ?? null,
          },
          application_url: grant.opportunity_application_url ?? null,
          eligibility_bullets: safeParseJSON(grant.opportunity_eligibility_bullets, []),
          categories: safeParseJSON(grant.opportunity_categories, []),
          keywords: safeParseJSON(grant.opportunity_keywords, []),
          requirements: {
            requires_501c3: grant.opportunity_requires_501c3 ?? null,
            requires_match: grant.opportunity_requires_match ?? null,
            match_percentage: grant.opportunity_match_percentage ?? null,
          },
        }
      : {
          // Fallback when the grant isn't linked to a funding_opportunities row.
          title: grant.title ?? null,
          funder: grant.funder ?? null,
          deadline: grant.deadline ?? null,
          application_url: grant.application_url ?? null,
        }

    const systemPrompt = `You are an expert grant writer.
Write compelling, specific grant content grounded in the applicant context and the funding source context.
If details are missing, ask for the missing info via clear bracketed placeholders rather than inventing facts.`

    const prompt =
      userPrompt ||
      `Write a ${section || 'project narrative'} section for a grant application (about 300-500 words).

APPLICANT CONTEXT:
${compactJson(applicantContext)}

FUNDING SOURCE CONTEXT:
${compactJson(opportunityContext)}

Requirements:
- Match tone/format expectations implied by the funder and opportunity description.
- Reuse specifics from the applicant context (mission, programs, location, current grant status).
- If eligibility bullets exist, ensure the narrative aligns to them.
- Use [PLACEHOLDER: ...] for unknown facts (do not guess).`;

    const result = await invokeTextWithFallback({
      model: DEFAULT_OPENAI_MODEL,
      system: systemPrompt,
      prompt,
      temperature: 0.7,
      maxTokens: 1500,
    })

    if (!result.text) {
      return res.json({
        content: fallbackProposalTemplate({ grant, section }),
        section,
        grant_id,
        tokens_used: 0,
        ai_provider: 'fallback',
        warning: 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider error.',
      })
    }

    res.json({
      content: result.text,
      section,
      grant_id,
      tokens_used: result.usage?.total_tokens || 0,
      ai_provider: result.provider,
    });
    
  } catch (error) {
    console.error('Error generating proposal:', error);
    res.status(500).json(formatError(error));
  }
});

// Analyze grant eligibility
router.post('/analyze/eligibility', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { profile_id, opportunity_id } = req.body;

    if (!profile_id) return res.status(400).json({ error: 'profile_id is required' })
    if (!(await ensureOrganizationAccess(req, res, String(profile_id)))) return
    
    const profile = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
    const isPgElig = req.db?.dialect === 'postgres'
    const actElig = isPgElig ? 'TRUE' : '1'
    const opportunity = await req.db.prepare(`
      SELECT * FROM funding_opportunities
      WHERE id = ? AND is_active = ${actElig}
        AND ${trustedOriginClause()} AND ${trustedSourceClause()}
    `).get(opportunity_id);
    
    if (!profile || !opportunity) {
      return res.status(404).json({ error: 'Profile or opportunity not found' });
    }
    
    const prompt = `Analyze if this applicant is eligible for this grant opportunity.

APPLICANT:
- Name: ${profile.name}
- Type: ${profile.applicant_type}
- State: ${profile.state}
- Veteran: ${profile.veteran ? 'Yes' : 'No'}
- First Generation: ${profile.first_generation ? 'Yes' : 'No'}
- Low Income: ${profile.snap_recipient ? 'Yes' : 'No'}

OPPORTUNITY:
- Title: ${opportunity.title}
- Sponsor: ${opportunity.sponsor}
- Eligibility: ${safeParseJSON(opportunity.eligibility_bullets, []).join('; ')}
- State: ${opportunity.state || 'National'}

Provide:
1. Overall eligibility assessment (Eligible / Likely Eligible / Possibly Eligible / Not Eligible)
2. Met requirements (list)
3. Unmet or unclear requirements (list)
4. Recommendations to improve eligibility

Return as JSON:
{
  "status": "...",
  "confidence": 0-100,
  "met_requirements": [...],
  "unmet_requirements": [...],
  "recommendations": [...]
}`;

    const result = await invokeTextWithFallback({
      model: DEFAULT_OPENAI_MODEL,
      prompt,
      temperature: 0.3,
      maxTokens: 1000,
    })

    if (!result.text) {
      const bullets = safeParseJSON(opportunity.eligibility_bullets, []).slice(0, 8)
      return res.json({
        status: 'Analysis unavailable (AI not configured)',
        confidence: 0,
        met_requirements: [],
        unmet_requirements: [],
        recommendations: [
          'Configure OPENAI_API_KEY or ANTHROPIC_API_KEY to enable AI eligibility analysis.',
          ...(bullets.length ? ['Review eligibility bullets and compare them to the applicant profile.'] : []),
        ],
        ai_provider: 'fallback',
        eligibility_bullets: bullets,
      })
    }

    const parsed = tryExtractFirstJson(result.text)
    res.json(
      parsed || {
        status: 'Analysis unavailable',
        raw_response: result.text,
        ai_provider: result.provider,
      },
    );
    
  } catch (error) {
    console.error('Error analyzing eligibility:', error);
    res.status(500).json(formatError(error));
  }
});

router.post('/reminders/plan', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const user = req.user ?? { role: 'guest' }
    const body = req.body || {};

    const lookahead = Number.isFinite(body.lookaheadDays)
      ? Math.max(7, Math.min(60, Math.trunc(body.lookaheadDays)))
      : undefined;

    let deadlines = Array.isArray(body.urgentDeadlines) ? body.urgentDeadlines : null;
    let milestones = Array.isArray(body.upcomingMilestones) ? body.upcomingMilestones : null;

    if (!deadlines || !milestones || deadlines.length === 0 || milestones.length === 0) {
      const snapshot = await (async () => {
        if (isAdminUser(user)) return await fetchReminderSnapshot(req.db, lookahead)
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        return await fetchReminderSnapshot(req.db, lookahead, { organizationIds: Array.from(orgIds ?? []) })
      })()
      deadlines = deadlines && deadlines.length > 0 ? deadlines : snapshot.urgentDeadlines;
      milestones = milestones && milestones.length > 0 ? milestones : snapshot.upcomingMilestones;
    }

    const trimmedDeadlines = (deadlines || []).slice(0, 6);
    const trimmedMilestones = (milestones || []).slice(0, 6);

    if (trimmedDeadlines.length === 0 && trimmedMilestones.length === 0) {
      return res.status(400).json({ error: 'No reminders available to generate a plan.' });
    }

    const prompt = buildReminderPlanPrompt(
      trimmedDeadlines,
      trimmedMilestones,
      { additionalContext: body.additionalContext },
    );

    const system =
      'You are an expert grants operations assistant. Provide actionable, concise plans without extra commentary.'
    const result = await invokeTextWithFallback({
      model: DEFAULT_OPENAI_MODEL,
      system,
      prompt,
      temperature: 0.4,
      maxTokens: 900,
    })

    let plan = null
    if (result.text) {
      plan = tryExtractFirstJson(result.text)
    }
    if (!plan) {
      // Deterministic fallback: convert deadlines/milestones into a simple checklist.
      plan = {
        overview:
          'AI plan generation is unavailable. Here is a structured checklist based on your upcoming deadlines and milestones.',
        priorities: [
          ...trimmedDeadlines.map((d) => ({
            type: 'deadline',
            title: d?.title || d?.name || 'Deadline',
            due_date: d?.date || d?.due_date || null,
            next_step: 'Confirm requirements and begin drafting required materials.',
          })),
          ...trimmedMilestones.map((m) => ({
            type: 'milestone',
            title: m?.title || m?.name || 'Milestone',
            due_date: m?.date || m?.due_date || null,
            next_step: 'Assign an owner and define deliverables.',
          })),
        ],
      }
    }

    res.json({
      plan,
      generatedAt: new Date().toISOString(),
      inputs: {
        deadlineCount: trimmedDeadlines.length,
        milestoneCount: trimmedMilestones.length,
      },
      ai_provider: plan && result.text ? result.provider : 'fallback',
    });
  } catch (error) {
    console.error('Error generating reminder plan:', error);
    res.status(500).json(formatError(error));
  }
});

// General LLM invocation endpoint
router.post('/invoke', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const {
      prompt,
      system_prompt,
      model = DEFAULT_OPENAI_MODEL,
      temperature = 0.3,
      max_tokens = 1200,
      response_json_schema,
      add_context_from_internet,
    } = req.body ?? {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Add length limits and basic sanitization
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ 
        error: 'prompt too long',
        message: `Prompt must be less than ${MAX_PROMPT_LENGTH} characters`
      });
    }

    // Basic sanitization: trim and normalize whitespace
    const sanitizedPrompt = prompt.trim().replace(/\s+/g, ' ');

    const messages = [
      {
        role: 'system',
        content: 'You are the GrantFlow AI assistant. Provide concise, factual answers that comply with any JSON instructions.',
      },
    ];

    if (system_prompt && typeof system_prompt === 'string') {
      messages.push({ role: 'system', content: system_prompt });
    }

    if (response_json_schema) {
      messages.push({
        role: 'system',
        content: `You must respond with valid JSON matching this schema: ${JSON.stringify(response_json_schema)}. Do not include any text outside of the JSON.`,
      });
    }

    let userPrompt = sanitizedPrompt;
    if (add_context_from_internet) {
      userPrompt = `${sanitizedPrompt}\n\n(Note: External web browsing is not available in this environment. Use only the information provided and your trained knowledge base.)`;
    }

    messages.push({ role: 'user', content: userPrompt });

    const systemCombined = messages
      .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim())
      .map((m) => m.content.trim())
      .join('\n\n')

    const result = await invokeTextWithFallback({
      model,
      system: systemCombined || null,
      prompt: userPrompt,
      temperature: typeof temperature === 'number' ? temperature : 0.3,
      maxTokens: typeof max_tokens === 'number' ? Math.max(1, Math.min(max_tokens, 4000)) : 1200,
    })

    const rawText = result.text || ''

    if (response_json_schema) {
      const tryParse = (text) => {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const candidate = text.slice(firstBrace, lastBrace + 1);
          return safeParseJSON(candidate, null);
        }
        return safeParseJSON(text, null);
      };

      try {
        const parsed = tryParse(rawText);
        if (!parsed) {
          throw new Error('Failed to parse JSON response');
        }
        return res.json(parsed);
      } catch (error) {
        console.error('Failed to parse InvokeLLM JSON response:', rawText, error);
        return res.status(502).json({
          error: 'AI returned invalid JSON response.',
          ai_provider: result.provider,
        });
      }
    }

    res.json({
      output: rawText,
      text: rawText,
      ai_provider: result.provider,
      warning: result.provider === 'fallback' ? 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider error.' : undefined,
    });
  } catch (error) {
    console.error('AI invoke failed:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * AI Portal Assistant — reads a funding portal page and helps users
 * answer application questions using their profile data.
 *
 * POST /api/ai/portal-assist
 * Body: { grant_id, portal_url?, questions?: string[], page_content?: string }
 */
router.post('/portal-assist', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { grant_id, portal_url, questions, page_content } = req.body;
    if (!grant_id) return res.status(400).json({ error: 'grant_id is required' });

    const grantAccess = await ensureGrantAccess(req, res, String(grant_id));
    if (!grantAccess) return;

    const grant = await req.db.prepare(`
      SELECT g.*, o.name AS org_name, o.mission AS org_mission,
             o.applicant_type AS org_type, o.city AS org_city, o.state AS org_state,
             o.ein AS org_ein, o.annual_budget AS org_budget,
             p.basic_information, p.education_information, p.employment_information,
             p.health_information, p.financial_information, p.housing_information,
             p.additional_information
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      LEFT JOIN profiles p ON g.profile_id = p.id
      WHERE g.id = ?
    `).get(grant_id);

    if (!grant) return res.status(404).json({ error: 'Grant not found' });

    // Parse profile sections
    const parseSafe = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; } };
    const profile = {
      basic: parseSafe(grant.basic_information),
      education: parseSafe(grant.education_information),
      employment: parseSafe(grant.employment_information),
      health: parseSafe(grant.health_information),
      financial: parseSafe(grant.financial_information),
      housing: parseSafe(grant.housing_information),
      additional: parseSafe(grant.additional_information),
    };

    // Fetch portal page content if URL given and no content provided
    let portalContent = page_content || '';
    if (!portalContent && portal_url) {
      try {
        const resp = await fetch(portal_url, {
          headers: { 'User-Agent': 'GrantFlow Application Assistant/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (resp.ok) {
          const html = await resp.text();
          portalContent = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .slice(0, 12000);
        }
      } catch (e) {
        console.warn('[portal-assist] Failed to fetch portal:', e?.message);
      }
    }

    const questionsText = Array.isArray(questions) && questions.length > 0
      ? questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')
      : '';

    const prompt = `You are an expert grant writer with an MBA and 20 years of experience securing funding for individuals and organizations. You write with precision, confidence, and persuasive clarity.

A user is applying for funding and needs help answering the application questions. Use their profile data to craft compelling, specific, truthful answers. Never fabricate facts — only use information from the profile. If information is missing, note what the applicant should add and provide a strong template they can customize.

=== FUNDING SOURCE ===
Title: ${grant.title || grant.name || 'Unknown'}
Funder: ${grant.funder_name || grant.org_name || 'Unknown'}
Description: ${grant.description || ''}
Amount: ${grant.amount || grant.amount_max || 'Not specified'}
URL: ${grant.application_url || grant.url || portal_url || ''}

=== APPLICANT PROFILE ===
Name: ${profile.basic?.first_name || ''} ${profile.basic?.last_name || ''}
Location: ${profile.basic?.city || ''}, ${profile.basic?.state || ''} ${profile.basic?.zip || ''}
Household size: ${profile.basic?.household_size || 'Unknown'}
Income: ${profile.financial?.annual_income || profile.basic?.annual_income || 'Unknown'}
Education: ${JSON.stringify(profile.education || {}).slice(0, 500)}
Employment: ${JSON.stringify(profile.employment || {}).slice(0, 500)}
Health: ${JSON.stringify(profile.health || {}).slice(0, 300)}
Housing: ${JSON.stringify(profile.housing || {}).slice(0, 300)}
Additional: ${JSON.stringify(profile.additional || {}).slice(0, 300)}
${grant.org_name ? `Organization: ${grant.org_name}` : ''}
${grant.org_mission ? `Mission: ${grant.org_mission}` : ''}
${grant.org_ein ? `EIN: ${grant.org_ein}` : ''}

${portalContent ? `=== PORTAL PAGE CONTENT ===\n${portalContent.slice(0, 8000)}` : ''}

${questionsText ? `=== QUESTIONS TO ANSWER ===\n${questionsText}` : `=== TASK ===\nAnalyze the funding source and portal content. Identify all questions or sections the applicant needs to complete. For each one, provide a polished, MBA-level draft answer using the profile data. Format as numbered sections.`}

For each answer:
1. Write a complete, submission-ready response (not bullet points)
2. Use specific details from the profile (income, location, household, needs)
3. Demonstrate clear alignment between the applicant's situation and the funder's mission
4. If a question asks about need, be specific and compelling — quantify where possible
5. Flag any fields where the applicant should verify or add information

Return your response as JSON:
{
  "answers": [
    {
      "question": "the question or section name",
      "answer": "the complete draft answer",
      "confidence": "high|medium|low",
      "missing_info": "what the applicant should verify/add, or null"
    }
  ],
  "summary": "brief overview of the application strength",
  "tips": ["actionable tip 1", "actionable tip 2"]
}`;

    const openai = getOpenAI();
    if (!openai) return res.status(503).json({ error: 'AI provider not configured' });

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 4000,
    });

    const rawText = extractCompletionText(completion);
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch { /* use raw */ }
    }

    res.json({
      success: true,
      result: parsed || { raw: rawText },
      grant_title: grant.title || grant.name,
      portal_url: portal_url || grant.application_url || grant.url || null,
    });
  } catch (error) {
    console.error('[portal-assist] Error:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * Generate a complete, print-ready application for physical submission (mail/fax).
 * POST /api/ai/generate-printable-application
 * Body: { grant_id }
 */
router.post('/generate-printable-application', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { grant_id } = req.body;
    if (!grant_id) return res.status(400).json({ error: 'grant_id is required' });

    const grantAccess = await ensureGrantAccess(req, res, String(grant_id));
    if (!grantAccess) return;

    const grant = await req.db.prepare(`
      SELECT g.*, o.name AS org_name, o.mission AS org_mission,
             o.applicant_type AS org_type, o.city AS org_city, o.state AS org_state,
             o.ein AS org_ein, o.annual_budget AS org_budget, o.website AS org_website,
             o.phone AS org_phone, o.address AS org_address,
             p.basic_information, p.education_information, p.employment_information,
             p.health_information, p.financial_information, p.housing_information,
             p.additional_information
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      LEFT JOIN profiles p ON g.profile_id = p.id
      WHERE g.id = ?
    `).get(grant_id);

    if (!grant) return res.status(404).json({ error: 'Grant not found' });

    const parseSafe = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; } };
    const p = {
      basic: parseSafe(grant.basic_information),
      education: parseSafe(grant.education_information),
      employment: parseSafe(grant.employment_information),
      health: parseSafe(grant.health_information),
      financial: parseSafe(grant.financial_information),
      housing: parseSafe(grant.housing_information),
      additional: parseSafe(grant.additional_information),
    };

    const applicantName = [p.basic?.first_name, p.basic?.last_name].filter(Boolean).join(' ') || 'Applicant';
    const applicantAddr = [p.basic?.address, p.basic?.city, p.basic?.state, p.basic?.zip].filter(Boolean).join(', ');
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = `You are a seasoned grant writer with an MBA and 20+ years securing millions in funding. Write a complete, formal application package ready for physical submission (print, mail, or fax).

=== FUNDING SOURCE ===
Title: ${grant.title || grant.name || 'Funding Opportunity'}
Funder: ${grant.funder_name || grant.org_name || 'Funding Organization'}
Description: ${grant.description || 'N/A'}
Amount: ${grant.amount || grant.amount_max || 'Not specified'}
Deadline: ${grant.deadline || 'Rolling/Open'}
Submission: ${grant.funder_address ? 'Mail to: ' + grant.funder_address : ''}${grant.funder_fax ? ' | Fax to: ' + grant.funder_fax : ''}${grant.funder_email ? ' | Email to: ' + grant.funder_email : ''}

=== APPLICANT ===
Name: ${applicantName}
Address: ${applicantAddr || 'Not provided'}
Phone: ${p.basic?.phone || 'Not provided'}
Email: ${p.basic?.email || 'Not provided'}
Household: ${p.basic?.household_size || 'Unknown'} members
Income: $${p.financial?.annual_income || p.basic?.annual_income || 'Unknown'}/year
Education: ${JSON.stringify(p.education || {}).slice(0, 400)}
Employment: ${JSON.stringify(p.employment || {}).slice(0, 400)}
Health: ${JSON.stringify(p.health || {}).slice(0, 300)}
Housing: ${JSON.stringify(p.housing || {}).slice(0, 300)}
Additional: ${JSON.stringify(p.additional || {}).slice(0, 300)}
${grant.org_name ? 'Organization: ' + grant.org_name : ''}
${grant.org_mission ? 'Mission: ' + grant.org_mission : ''}
${grant.org_ein ? 'EIN: ' + grant.org_ein : ''}

=== INSTRUCTIONS ===
Generate a COMPLETE application package as JSON with these sections:

1. cover_letter: A formal, persuasive cover letter (full text) addressed to the funder. Include:
   - Professional letterhead info (applicant name, address, date)
   - Specific reference to the funding opportunity by name
   - Compelling statement of need using real profile data (quantify: income, household size, specific needs)
   - Clear alignment between the applicant's situation and the funder's mission
   - Professional closing with signature line

2. narrative: A 2-3 paragraph statement of need/project narrative that:
   - Opens with the applicant's specific situation and quantified need
   - Demonstrates exactly how this funding addresses their situation
   - Shows the impact/outcome if funded
   - Uses persuasive but honest language — no fabrication

3. budget_justification: If applicable, a brief budget narrative explaining how funds will be used

4. sections: Array of any additional form sections the funder likely requires, each with:
   - section_name, content (the completed answer)

5. submission_instructions: Step-by-step checklist for the applicant:
   - What to print
   - What to sign
   - What supporting documents to include (ID, proof of income, etc.)
   - Where to mail/fax/deliver
   - Deadline reminder

6. missing_items: Array of things the applicant needs to gather/verify before submitting

Return ONLY valid JSON:
{
  "cover_letter": "full text...",
  "narrative": "full text...",
  "budget_justification": "text or null",
  "sections": [{ "section_name": "...", "content": "..." }],
  "submission_instructions": ["step 1...", "step 2..."],
  "missing_items": ["item 1...", "item 2..."],
  "addressed_to": { "name": "...", "title": "...", "organization": "...", "address": "...", "fax": "...", "email": "..." },
  "applicant": { "name": "${applicantName}", "address": "${applicantAddr}", "date": "${today}" }
}`;

    const openai = getOpenAI();
    if (!openai) return res.status(503).json({ error: 'AI provider not configured' });

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 6000,
    });

    const rawText = extractCompletionText(completion);
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch { /* use raw */ }
    }

    res.json({
      success: true,
      application: parsed || { raw: rawText },
      grant_title: grant.title || grant.name,
      funder: grant.funder_name || grant.org_name || null,
      submission: {
        address: grant.funder_address || null,
        fax: grant.funder_fax || null,
        email: grant.funder_email || null,
      },
    });
  } catch (error) {
    console.error('[generate-printable-application] Error:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * Analyze a profile and generate a smart list of items/services the person
 * likely needs, based on their goals and situation. Then for each item,
 * indicate whether it can be donated, granted, or must be purchased.
 *
 * POST /api/ai/discover-needs
 * Body: { profile_id, custom_goal?: string }
 */
router.post('/discover-needs', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { profile_id, custom_goal } = req.body;
    if (!profile_id) return res.status(400).json({ error: 'profile_id is required' });

    const profile = await req.db.prepare(`
      SELECT p.*
      FROM profiles p
      WHERE p.id = ?
    `).get(profile_id);

    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const parseSafe = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; } };
    const p = {
      basic: parseSafe(profile.basic_information),
      education: parseSafe(profile.education_information),
      employment: parseSafe(profile.employment_information),
      health: parseSafe(profile.health_information),
      financial: parseSafe(profile.financial_information),
      housing: parseSafe(profile.housing_information),
      additional: parseSafe(profile.additional_information),
    };

    const applicantName = [p.basic?.first_name, p.basic?.last_name].filter(Boolean).join(' ') || 'Applicant';

    const prompt = `You are an expert needs assessor and resource navigator. Analyze this person's profile and identify EVERY tangible item, service, credential, or resource they need to achieve their goals.

=== PROFILE ===
Name: ${applicantName}
Location: ${[p.basic?.city, p.basic?.state].filter(Boolean).join(', ') || 'Unknown'}
${custom_goal ? `Stated Goal: ${custom_goal}` : ''}
Education: ${JSON.stringify(p.education || {}).slice(0, 500)}
Employment: ${JSON.stringify(p.employment || {}).slice(0, 500)}
Health: ${JSON.stringify(p.health || {}).slice(0, 400)}
Financial: ${JSON.stringify(p.financial || {}).slice(0, 400)}
Housing: ${JSON.stringify(p.housing || {}).slice(0, 400)}
Additional: ${JSON.stringify(p.additional || {}).slice(0, 400)}

=== INSTRUCTIONS ===
Based on everything in this profile, generate a comprehensive list of items and services this person needs. Think about:
- Their stated or implied goals (career, business, education, health, housing)
- What equipment, tools, credentials, or services those goals require
- What barriers exist (financial, health, transportation) and what items address them
- Both the big-ticket items AND the smaller necessities people often forget

For each item, classify it into one of these funding paths:
- "donation" — organizations exist that donate this item for free
- "grant" — grants or programs exist that fund the purchase of this item
- "benefit" — a government benefit or assistance program covers this
- "scholarship" — educational funding covers this
- "self_fund" — typically must be purchased, but may have discount programs

Return ONLY valid JSON:
{
  "goal_summary": "1-2 sentence summary of what this person is trying to achieve",
  "items": [
    {
      "name": "the specific item or service",
      "category": "equipment|credential|service|technology|vehicle|training|supplies|housing|medical|legal",
      "why_needed": "brief explanation of why this person specifically needs it",
      "funding_path": "donation|grant|benefit|scholarship|self_fund",
      "search_terms": "what to search for to find funding (optimized for web search)",
      "priority": "critical|high|medium|low",
      "estimated_cost": "$X - $Y or free"
    }
  ]
}

Generate 8-20 items, ordered by priority (critical first). Be SPECIFIC to this person's situation — not generic. If they want to start a food truck, list the actual items (food truck, commercial equipment, food handler's license, POS system, commissary access, etc.). If they need nursing license reinstatement, list the specific classes, exam fees, background checks, etc.`;

    const openai = getOpenAI();
    if (!openai) return res.status(503).json({ error: 'AI provider not configured' });

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 4000,
    });

    const rawText = extractCompletionText(completion);
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch { /* use raw */ }
    }

    res.json({
      success: true,
      profile_id,
      applicant_name: applicantName,
      custom_goal: custom_goal || null,
      result: parsed || { raw: rawText },
    });
  } catch (error) {
    console.error('[discover-needs] Error:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * Generate a printable profile todo checklist with detailed step-by-step instructions.
 * Analyzes the profile, pipeline grants, and needs to produce an actionable plan.
 *
 * POST /api/ai/generate-profile-todo
 * Body: { profile_id }
 */
router.post('/generate-profile-todo', enforceTierCapability(TIER_CAPABILITIES.DOCUMENT_AI), async (req, res) => {
  try {
    const { profile_id } = req.body;
    if (!profile_id) return res.status(400).json({ error: 'profile_id is required' });

    const db = req.db;

    const profile = await db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(profile_id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const parseSafe = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; } };
    const p = {
      basic: parseSafe(profile.basic_information),
      education: parseSafe(profile.education_information),
      employment: parseSafe(profile.employment_information),
      health: parseSafe(profile.health_information),
      financial: parseSafe(profile.financial_information),
      housing: parseSafe(profile.housing_information),
      additional: parseSafe(profile.additional_information),
      narrative: parseSafe(profile.narrative_information),
    };

    const applicantName = profile.display_name
      || [p.basic?.first_name, p.basic?.last_name].filter(Boolean).join(' ')
      || 'Applicant';

    let grants = [];
    try {
      grants = await db.prepare(`
        SELECT id, title, funder, status, deadline, amount, description, url, application_url,
               match_score, match_reasons, funding_opportunity_id
        FROM grants
        WHERE profile_id = ?
        ORDER BY
          CASE status
            WHEN 'discovery' THEN 1 WHEN 'discovered' THEN 2 WHEN 'interested' THEN 3
            WHEN 'application_prep' THEN 4 WHEN 'drafting' THEN 5 WHEN 'portal' THEN 6
            WHEN 'submitted' THEN 7 WHEN 'pending_review' THEN 8 WHEN 'follow_up' THEN 9
            WHEN 'awarded' THEN 10 ELSE 99
          END,
          deadline ASC NULLS LAST
      `).all(profile_id);
    } catch { /* grants table may not have profile_id */ }

    const sections = [];
    try {
      const rows = await db.prepare(`SELECT section_key, data FROM profile_sections WHERE profile_id = ?`).all(profile_id);
      for (const row of rows) {
        sections.push({ key: row.section_key, data: parseSafe(row.data) });
      }
    } catch { /* profile_sections may not exist */ }

    const activeGrants = grants.filter(g =>
      !['declined', 'declined_no_review', 'closed'].includes(g.status)
    );
    const pipelineSummary = activeGrants.slice(0, 20).map(g => ({
      title: g.title || 'Untitled',
      funder: g.funder || '',
      status: g.status || 'discovery',
      deadline: g.deadline || null,
      amount: g.amount || null,
      url: g.url || g.application_url || null,
      match_score: g.match_score || null,
    }));

    const prompt = `You are an expert case manager and grant advisor. Analyze this person's complete profile and their funding pipeline, then generate a COMPREHENSIVE, ACTIONABLE TODO CHECKLIST they can print out and work through step by step.

=== PROFILE ===
Name: ${applicantName}
Profile Type: ${profile.primary_type || 'individual'}
Location: ${[p.basic?.city, p.basic?.state, p.basic?.zip_code].filter(Boolean).join(', ') || 'Unknown'}
Education: ${JSON.stringify(p.education || {}).slice(0, 600)}
Employment: ${JSON.stringify(p.employment || {}).slice(0, 600)}
Health: ${JSON.stringify(p.health || {}).slice(0, 400)}
Financial: ${JSON.stringify(p.financial || {}).slice(0, 400)}
Housing: ${JSON.stringify(p.housing || {}).slice(0, 400)}
Narrative/Goals: ${JSON.stringify(p.narrative || {}).slice(0, 600)}
Additional: ${JSON.stringify(p.additional || {}).slice(0, 400)}
${sections.length > 0 ? `Profile Sections: ${JSON.stringify(sections.map(s => ({ key: s.key, summary: JSON.stringify(s.data).slice(0, 200) }))).slice(0, 1500)}` : ''}

=== FUNDING PIPELINE (${activeGrants.length} active opportunities) ===
${pipelineSummary.length > 0 ? JSON.stringify(pipelineSummary, null, 1) : 'No funding opportunities in pipeline yet.'}

=== INSTRUCTIONS ===
Generate a structured todo list covering these categories (skip any that don't apply):

1. PROFILE COMPLETION — what sections still need to be filled in, what documents to gather
2. IMMEDIATE ACTIONS — urgent deadlines, time-sensitive opportunities, critical next steps
3. APPLICATION TASKS — for each pipeline opportunity, what specific steps to complete (gather documents, fill out forms, write narratives, get references, etc.)
4. FINANCIAL PREPARATION — documents to collect, budgets to prepare, financial statements needed
5. PROFESSIONAL DEVELOPMENT — certifications, training, licenses, courses to complete
6. DOCUMENT GATHERING — birth certificates, ID, tax returns, letters of support, transcripts, etc.
7. FOLLOW-UP ACTIONS — things to check on, people to contact, statuses to verify
8. LONG-TERM PLANNING — goals to work toward, future opportunities to watch for

For each todo item, provide:
- A clear, specific action statement (not vague)
- Detailed step-by-step instructions on HOW to complete it
- Any relevant deadlines or timeframes
- What documents, information, or resources are needed
- Who to contact or where to go (if applicable)
- Priority level (critical, high, medium, low)
- If (and ONLY if) the item is about filling in a missing PROFILE field, set "profile_section" to the matching profile section key so the app can deep-link the user straight to it. Allowed keys: basic_information, demographics, financial_information, education, employment, health_medical, housing, narrative, additional, university_applications, documents. When the item refers to a specific field, also set "field_key" (e.g. first_name, last_name, email, phone, household_income, school_name). Omit both (use null) for real-world actions that are not about a profile field (e.g. "request a transcript from your school", "call the funder").

Be SPECIFIC to this person's actual situation. Reference their real profile data, their real pipeline opportunities, and their actual needs. Don't be generic.

Return ONLY valid JSON:
{
  "applicant_name": "the person's name",
  "generated_date": "today's date",
  "summary": "1-2 sentence overview of where this person stands and what they need to focus on",
  "categories": [
    {
      "name": "Category Name",
      "icon": "clipboard|clock|file-text|dollar-sign|award|folder|phone|target",
      "items": [
        {
          "title": "Clear action statement",
          "priority": "critical|high|medium|low",
          "deadline": "specific date or timeframe if applicable, or null",
          "instructions": "Detailed step-by-step instructions. Be thorough — this is what they'll print and follow.",
          "resources_needed": "What they need to complete this (documents, information, etc.)",
          "contact_or_location": "Who to contact or where to go, if applicable",
          "profile_section": "matching profile section key if this is a profile-field item, else null",
          "field_key": "matching field key if known, else null"
        }
      ]
    }
  ],
  "total_items": number
}`;

    const openai = getOpenAI();
    if (!openai) return res.status(503).json({ error: 'AI provider not configured' });

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 6000,
    });

    const rawText = extractCompletionText(completion);
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch { /* use raw */ }
    }

    res.json({
      success: true,
      profile_id,
      applicant_name: applicantName,
      pipeline_count: activeGrants.length,
      todo: parsed || { raw: rawText },
    });
  } catch (error) {
    console.error('[generate-profile-todo] Error:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * AI School Data Lookup — uses Anthropic with web search to auto-fill
 * admissions snapshot fields for a university application.
 *
 * POST /api/ai/school-lookup
 * Body: { school_name: string }
 */
router.post('/school-lookup', async (req, res) => {
  try {
    const { school_name } = req.body;
    if (!school_name || typeof school_name !== 'string' || !school_name.trim()) {
      return res.status(400).json({ error: 'school_name is required' });
    }

    const trimmedName = school_name.trim();
    const fallbackData = buildSchoolLookupFallbackData(trimmedName)
    routeLogger.info(`[school-lookup] Looking up data for: ${trimmedName}`);

    const anthropic = await createAnthropicClient();
    if (!anthropic) {
      // Fall back to OpenAI without web search
      const result = await invokeTextWithFallback({
        prompt: `Look up the following information for "${trimmedName}" and return ONLY a JSON object with these exact keys. Use "—" for any value you cannot find. Do not include any other text, markdown, or explanation.\n\nKeys:\n- acceptanceRate (e.g. "65%")\n- avgGPA (e.g. "3.4")\n- satRange (e.g. "1050-1250")\n- tuition (e.g. "$28,900/yr")\n- fafsaCode (e.g. "003525")\n- graduationRate (e.g. "52%")\n- studentTeacher (e.g. "14:1")\n- avgClassSize (e.g. "18")\n- estCost (e.g. "$38,200/yr" — total estimated cost of attendance)\n- enrollment (e.g. "5,200")\n- founded (e.g. "1901")\n- type (e.g. "Private, Nonprofit" or "Public")\n- setting (e.g. "Urban" or "Suburban")\n\nReturn ONLY the JSON object, no backticks, no explanation.`,
        temperature: 0.1,
        maxTokens: 1000,
      });

      if (!result.text) {
        return res.json({
          success: true,
          school_name: trimmedName,
          data: fallbackData,
          provider: 'fallback',
          warning: 'AI provider unavailable; returned registry-backed fallback data.',
        });
      }

      const parsed = tryExtractFirstJson(result.text);
      if (!parsed) {
        return res.json({
          success: true,
          school_name: trimmedName,
          data: fallbackData,
          provider: 'fallback',
          warning: 'Failed to parse AI response; returned registry-backed fallback data.',
        });
      }

      return res.json({ success: true, school_name: trimmedName, data: parsed, provider: result.provider });
    }

    // Use Anthropic with web search for best results
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL_SCHOOL_LOOKUP || 'claude-sonnet-4-6',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{
        role: 'user',
        content: `Look up the following information for "${trimmedName}" and return ONLY a JSON object with these exact keys. Use "—" for any value you cannot find. Do not include any other text, markdown, or explanation.

Keys:
- acceptanceRate (e.g. "65%")
- avgGPA (e.g. "3.4")
- satRange (e.g. "1050-1250")
- tuition (e.g. "$28,900/yr")
- fafsaCode (e.g. "003525")
- graduationRate (e.g. "52%")
- studentTeacher (e.g. "14:1")
- avgClassSize (e.g. "18")
- estCost (e.g. "$38,200/yr" — total estimated cost of attendance)
- enrollment (e.g. "5,200")
- founded (e.g. "1901")
- type (e.g. "Private, Nonprofit" or "Public")
- setting (e.g. "Urban" or "Suburban")

Return ONLY the JSON object, no backticks, no explanation.`
      }],
    });

    const textBlocks = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    let parsed = null;
    try {
      parsed = JSON.parse(textBlocks.trim());
    } catch {
      parsed = tryExtractFirstJson(textBlocks);
    }

    if (!parsed) {
      console.warn('[school-lookup] Could not parse response:', textBlocks.slice(0, 300));
      return res.json({
        success: true,
        school_name: trimmedName,
        data: fallbackData,
        provider: 'fallback',
        warning: 'Failed to parse AI response; returned registry-backed fallback data.',
      });
    }

    routeLogger.info(`[school-lookup] Success for ${trimmedName}: ${Object.keys(parsed).length} fields`);
    return res.json({ success: true, school_name: trimmedName, data: parsed, provider: 'anthropic-web-search' });
  } catch (error) {
    console.error('[school-lookup] Error:', error);
    // Degrade gracefully — the AI-assist button must never be "dead". A model
    // retirement, web_search outage, or timeout should fall back to registry
    // data with a 200, not a 500 the frontend renders as "Internal server error".
    try {
      const name = String(req.body?.school_name || '').trim();
      if (name) {
        return res.json({
          success: true,
          school_name: name,
          data: buildSchoolLookupFallbackData(name),
          provider: 'fallback',
          warning: `AI lookup failed (${error?.message || 'unknown error'}); returned registry-backed fallback data.`,
        });
      }
    } catch { /* fall through to error response */ }
    res.status(500).json(formatError(error));
  }
});

export default router;
