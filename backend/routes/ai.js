import express from 'express';
import { fetchReminderSnapshot } from './reminders.js';
import { buildReminderPlanPrompt } from '../prompts/reminderPlan.js';
import { extractCompletionText } from '../utils/openai.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { formatError } from '../middleware/errorHandler.js';
import { validatePagination } from '../utils/validation.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_TIMEOUT_MS, MAX_PROMPT_LENGTH } from '../config/constants.js';
import { calculateMatchScore } from '../services/matchingEngine.js';
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js';
import { enforceTierCapability } from '../middleware/entitlements.js'
import { TIER_CAPABILITIES } from '../utils/tierGating.js'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  isAdminUser,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'

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
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
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
  return `Draft ${focus} (non-AI fallback)\n\nApplicant: ${applicant}\nGrant: ${title}\nFunder: ${funder}\n\n1) Need / Problem\n- [Describe the specific community need and who is impacted.]\n\n2) Project Overview\n- [What you will do, where, and for whom.]\n\n3) Activities & Timeline\n- [List 3-6 key activities with target dates.]\n\n4) Outcomes & Measurement\n- [List measurable outcomes and how you will track them.]\n\n5) Budget & Sustainability\n- [How funds will be used and how the work continues after funding.]\n`
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
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
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
    const { profile } = req.body
    
    // Get all opportunities from database
    const opportunities = await req.db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE is_active = TRUE 
      ORDER BY created_at DESC 
      LIMIT 100
    `).all()
    
    // Calculate match scores using deterministic algorithm
    const scoredOpps = opportunities.map(opp => {
      const matchResult = calculateMatchScore(profile, opp);
      return {
        ...opp,
        fit_score: matchResult.score,
        match_reasons: matchResult.reasons
      };
    });
    
    res.json({
      opportunities: scoredOpps.filter(o => o.fit_score >= 50), // Minimum threshold
      total: scoredOpps.length,
      profile
    })
  } catch (error) {
    console.error('Comprehensive match error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ECF service search endpoint
router.post('/ecf-service-search', async (req, res) => {
  try {
    const { profile } = req.body
    
    const services = [
      {
        name: 'Respite Care Services',
        description: 'Temporary relief for caregivers',
        provider: 'Regional DD Board',
        match_score: 92
      },
      {
        name: 'Assistive Technology',
        description: 'Adaptive equipment and devices',
        provider: 'AT Program',
        match_score: 88
      },
      {
        name: 'Community Integration Support',
        description: 'Social and community participation',
        provider: 'ECF CHOICES',
        match_score: 85
      }
    ]
    
    res.json({
      services,
      total: services.length,
      profile
    })
  } catch (error) {
    console.error('ECF service search error:', error)
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
    
    // Parse JSON fields safely
    const keywords = safeParseJSON(profile.keywords, []);
    const focusAreas = safeParseJSON(profile.focus_areas, []);
    const programAreas = safeParseJSON(profile.program_areas, []);
    
    // Get opportunities matching state or national
    let query = `
      SELECT * FROM funding_opportunities 
      WHERE is_active = TRUE 
      AND (is_national = TRUE OR state = ? OR state IS NULL)
    `;
    const params = [profile.state];
    
    // Filter by deadline (not expired)
    query += ` AND (deadline >= CURRENT_DATE OR deadline IS NULL OR deadline_type = 'rolling')`;
    
    query += ' ORDER BY deadline ASC NULLS LAST LIMIT ?';
    params.push(limit * 2); // Get more than needed for AI scoring
    
    const opportunities = await req.db.prepare(query).all(...params);
    
    if (opportunities.length === 0) {
      return res.json({ opportunities: [], count: 0, profile_id });
    }
    
    // Score opportunities using keyword matching
    const scoredOpportunities = opportunities.map(opp => {
      const oppText = `${opp.title || ''} ${opp.description || ''} ${opp.sponsor || ''}`.toLowerCase();
      const eligibility = safeParseJSON(opp.eligibility_bullets, []).join(' ').toLowerCase();
      const combined = `${oppText} ${eligibility}`;
      
      let score = 50; // Base score
      const matchReasons = [];
      
      // Geographic match
      if (opp.is_national || opp.state === profile.state) {
        score += 10;
        matchReasons.push('Geographic match');
      }
      
      // Keyword matching
      const allKeywords = [...keywords, ...focusAreas, ...programAreas];
      const matchedKeywords = [];
      
      allKeywords.forEach(keyword => {
        if (keyword && combined.includes(keyword.toLowerCase())) {
          score += 5;
          matchedKeywords.push(keyword);
        }
      });
      
      if (matchedKeywords.length > 0) {
        matchReasons.push(`Keywords: ${matchedKeywords.slice(0, 3).join(', ')}`);
      }
      
      // Applicant type matching
      if (profile.applicant_type) {
        const typeKeywords = {
          'individual_need': ['individual', 'personal', 'person', 'citizen'],
          'nonprofit': ['nonprofit', '501c3', 'organization', 'charity'],
          'small_business': ['business', 'entrepreneur', 'startup', 'company'],
          'student': ['student', 'scholarship', 'education', 'college', 'university']
        };
        
        const keywords = typeKeywords[profile.applicant_type] || [];
        keywords.forEach(kw => {
          if (combined.includes(kw)) {
            score += 5;
            if (!matchReasons.includes('Applicant type match')) {
              matchReasons.push('Applicant type match');
            }
          }
        });
      }
      
      // Veteran matching
      if (profile.veteran && (combined.includes('veteran') || combined.includes('military'))) {
        score += 15;
        matchReasons.push('Veteran eligible');
      }
      
      // Disability matching
      if (profile.disabled && (combined.includes('disab') || combined.includes('special needs'))) {
        score += 15;
        matchReasons.push('Disability support');
      }
      
      // First generation matching
      if (profile.first_generation && combined.includes('first generation')) {
        score += 10;
        matchReasons.push('First generation');
      }
      
      // Low income matching
      if (profile.snap_recipient || profile.ssi_recipient || profile.tanf_recipient) {
        if (combined.includes('low income') || combined.includes('need-based') || combined.includes('financial need')) {
          score += 10;
          matchReasons.push('Need-based');
        }
      }
      
      return {
        ...opp,
        eligibility_bullets: safeParseJSON(opp.eligibility_bullets, []),
        categories: safeParseJSON(opp.categories, []),
        keywords: safeParseJSON(opp.keywords, []),
        match_score: Math.min(score, 100),
        match_reasons: matchReasons.slice(0, 5)
      };
    });
    
    // Sort by score and limit
    const topMatches = scoredOpportunities
      .filter(o => o.match_score >= 50)
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
    if (opportunity_ids && opportunity_ids.length > 0) {
      const placeholders = opportunity_ids.map(() => '?').join(',');
      opportunities = await req.db.prepare(`
        SELECT * FROM funding_opportunities WHERE id IN (${placeholders})
      `).all(...opportunity_ids);
    } else {
      // Get basic matches first
      opportunities = await req.db.prepare(`
        SELECT * FROM funding_opportunities 
        WHERE is_active = TRUE 
        AND (is_national = TRUE OR state = ? OR state IS NULL)
        AND (deadline >= CURRENT_DATE OR deadline IS NULL OR deadline_type = 'rolling')
        LIMIT ?
      `).all(profile.state, limit * 2);
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
            model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
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
    const opportunity = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
    
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

// General LLM invocation endpoint (Base44 SDK compatibility)
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

export default router;
