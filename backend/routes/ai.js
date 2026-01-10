import express from 'express';
import OpenAI from 'openai';
import { fetchReminderSnapshot } from './reminders.js';
import { buildReminderPlanPrompt } from '../prompts/reminderPlan.js';
import { extractCompletionText } from '../utils/openai.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { formatError } from '../middleware/errorHandler.js';
import { validatePagination } from '../utils/validation.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_TIMEOUT_MS, MAX_PROMPT_LENGTH } from '../config/constants.js';
import { calculateMatchScore } from '../services/matchingEngine.js';

const router = express.Router();

// Initialize OpenAI client
const getOpenAI = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  return new OpenAI({ apiKey });
};

// Match opportunities to a profile
// Comprehensive match endpoint for discovery
router.post('/comprehensive-match', async (req, res) => {
  try {
    const { profile } = req.body
    
    // Get all opportunities from database
    const opportunities = req.db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE is_active = 1 
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
    
    // Get the organization profile
    const profile = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
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
      WHERE is_active = 1 
      AND (is_national = 1 OR state = ? OR state IS NULL)
    `;
    const params = [profile.state];
    
    // Filter by deadline (not expired)
    query += ` AND (deadline >= date('now') OR deadline IS NULL OR deadline_type = 'rolling')`;
    
    query += ' ORDER BY deadline ASC NULLS LAST LIMIT ?';
    params.push(limit * 2); // Get more than needed for AI scoring
    
    const opportunities = req.db.prepare(query).all(...params);
    
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
router.post('/match/ai', async (req, res) => {
  try {
    const { profile_id, opportunity_ids } = req.body;
    const { limit } = validatePagination({ limit: req.body.limit || 20 });
    
    const openai = getOpenAI();
    
    // Get the profile
    const profile = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // Get opportunities (either specific ones or top matches)
    let opportunities;
    if (opportunity_ids && opportunity_ids.length > 0) {
      const placeholders = opportunity_ids.map(() => '?').join(',');
      opportunities = req.db.prepare(`
        SELECT * FROM funding_opportunities WHERE id IN (${placeholders})
      `).all(...opportunity_ids);
    } else {
      // Get basic matches first
      opportunities = req.db.prepare(`
        SELECT * FROM funding_opportunities 
        WHERE is_active = 1 
        AND (is_national = 1 OR state = ? OR state IS NULL)
        AND (deadline >= date('now') OR deadline IS NULL OR deadline_type = 'rolling')
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

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000
    });
    
    let aiResults;
    try {
      const content = extractCompletionText(completion);
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      aiResults = safeParseJSON(jsonMatch ? jsonMatch[0] : content, null);
      if (!aiResults) {
        throw new Error('Failed to parse AI response');
      }
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
router.post('/generate/proposal', async (req, res) => {
  try {
    const { grant_id, section, prompt: userPrompt } = req.body;
    
    const openai = getOpenAI();
    
    // Get grant details
    const grant = req.db.prepare(`
      SELECT g.*, o.* 
      FROM grants g
      JOIN organizations o ON g.organization_id = o.id
      WHERE g.id = ?
    `).get(grant_id);
    
    if (!grant) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    
    const systemPrompt = `You are an expert grant writer. Generate compelling, specific content for grant applications. 
Be specific, use concrete examples, and tailor the content to the applicant's profile and the grant requirements.
Write in a professional but engaging tone.`;

    const prompt = userPrompt || `Write a ${section || 'project narrative'} section for a grant application.

APPLICANT: ${grant.name}
TYPE: ${grant.applicant_type}
MISSION: ${grant.mission || 'Not specified'}
FUNDING NEEDED: ${grant.funding_amount_needed || 'Not specified'}

GRANT: ${grant.title}
FUNDER: ${grant.funder}

Generate a well-structured, compelling ${section || 'narrative'} of about 300-500 words.`;

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });
    
    res.json({
      content: extractCompletionText(completion),
      section,
      grant_id,
      tokens_used: completion.usage?.total_tokens || 0
    });
    
  } catch (error) {
    console.error('Error generating proposal:', error);
    res.status(500).json(formatError(error));
  }
});

// Analyze grant eligibility
router.post('/analyze/eligibility', async (req, res) => {
  try {
    const { profile_id, opportunity_id } = req.body;
    
    const openai = getOpenAI();
    
    const profile = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(profile_id);
    const opportunity = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
    
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

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000
    });
    
    let analysis;
    try {
    const content = extractCompletionText(completion);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      analysis = safeParseJSON(jsonMatch ? jsonMatch[0] : content, null);
      if (!analysis) {
        analysis = {
          status: 'Analysis unavailable',
          raw_response: content
        };
      }
    } catch {
      analysis = {
        status: 'Analysis unavailable',
      raw_response: extractCompletionText(completion)
      };
    }
    
    res.json(analysis);
    
  } catch (error) {
    console.error('Error analyzing eligibility:', error);
    res.status(500).json(formatError(error));
  }
});

router.post('/reminders/plan', async (req, res) => {
  try {
    const openai = getOpenAI();
    const body = req.body || {};

    const lookahead = Number.isFinite(body.lookaheadDays)
      ? Math.max(7, Math.min(60, Math.trunc(body.lookaheadDays)))
      : undefined;

    let deadlines = Array.isArray(body.urgentDeadlines) ? body.urgentDeadlines : null;
    let milestones = Array.isArray(body.upcomingMilestones) ? body.upcomingMilestones : null;

    if (!deadlines || !milestones || deadlines.length === 0 || milestones.length === 0) {
      const snapshot = fetchReminderSnapshot(req.db, lookahead);
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

    const completion = await openai.chat.completions.create({
      model: DEFAULT_OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert grants operations assistant. Provide actionable, concise plans without extra commentary.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 900,
    });

    let plan;
    try {
    const content = extractCompletionText(completion);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      plan = safeParseJSON(jsonMatch ? jsonMatch[0] : content, null);
      if (!plan) {
        throw new Error('Failed to parse plan');
      }
    } catch (parseError) {
      console.error('Failed to parse reminder plan response:', parseError);
      return res.status(502).json({ error: 'AI response could not be parsed.' });
    }

    res.json({
      plan,
      generatedAt: new Date().toISOString(),
      inputs: {
        deadlineCount: trimmedDeadlines.length,
        milestoneCount: trimmedMilestones.length,
      },
    });
  } catch (error) {
    console.error('Error generating reminder plan:', error);
    res.status(500).json(formatError(error));
  }
});

// General LLM invocation endpoint (Base44 SDK compatibility)
router.post('/invoke', async (req, res) => {
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

    const openai = getOpenAI();

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

    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.3,
      max_tokens: typeof max_tokens === 'number' ? Math.max(1, Math.min(max_tokens, 4000)) : 1200,
    });

    const rawText = extractCompletionText(completion);

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
        return res.status(502).json({ error: 'AI returned invalid JSON response.' });
      }
    }

    res.json({
      output: rawText,
      text: rawText,
    });
  } catch (error) {
    console.error('AI invoke failed:', error);
    res.status(500).json(formatError(error));
  }
});

export default router;
