import { base44 } from '@/api/base44Client';

/**
 * Check if a grant already has AI analysis
 * @param {string} grantId - Grant ID
 * @returns {Promise<boolean>} Whether analysis exists
 */
export async function hasExistingAnalysis(grantId) {
  if (!grantId) return false;

  try {
    const artifacts = await base44.entities.AiArtifact.filter({
      grant_id: grantId,
      kind: 'analysis',
    });
    return Array.isArray(artifacts) && artifacts.length > 0;
  } catch (error) {
    console.error('[aiAssessmentService] Error checking existing analysis:', error);
    return false;
  }
}

/** sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** clamp number to [min, max] */
const clamp = (n, min, max) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
};

/** ensure array<string> */
const toStringArray = (arr, max = 50) => {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const s = (typeof item === 'string' ? item : String(item ?? '')).trim();
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

/** validate recommendation enum */
const toRecommendation = (v) => {
  const s = String(v || '').toLowerCase();
  const allowed = ['highly_recommend', 'recommend', 'consider', 'not_recommended'];
  return allowed.includes(s) ? s : 'consider';
};

/**
 * Run AI analysis on a grant
 * @param {Object} grant - Grant object
 * @param {Object} organization - Organization object
 * @returns {Promise<Object>} Analysis result
 */
async function runAnalysis(grant, organization) {
  // Guard LLM availability
  const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
  if (!invokeLLM) {
    throw new Error('AI service unavailable. Please try again later.');
  }

  // Keep prompts bounded to avoid huge payloads
  const safeGrant = JSON.stringify(grant).slice(0, 20000);
  const safeOrg = JSON.stringify(organization).slice(0, 20000);

  const analysisPrompt = `Analyze this opportunity for the applicant. Return a JSON object with keys:
- eligibility_score (0-10)
- mission_alignment_score (0-10)
- your_advantages (array of strings)
- potential_weaknesses (array of strings)
- recommendation ("highly_recommend" | "recommend" | "consider" | "not_recommended")

APPLICANT: ${safeOrg}
OPPORTUNITY: ${safeGrant}`;

  const raw = await invokeLLM({
    prompt: analysisPrompt,
    response_json_schema: {
      type: 'object',
      properties: {
        eligibility_score: { type: 'number' },
        mission_alignment_score: { type: 'number' },
        your_advantages: { type: 'array', items: { type: 'string' } },
        potential_weaknesses: { type: 'array', items: { type: 'string' } },
        recommendation: { type: 'string' },
      },
    },
  });

  // Coerce & validate fields
  const analysisResult = {
    eligibility_score: clamp(raw?.eligibility_score, 0, 10),
    mission_alignment_score: clamp(raw?.mission_alignment_score, 0, 10),
    your_advantages: toStringArray(raw?.your_advantages, 50),
    potential_weaknesses: toStringArray(raw?.potential_weaknesses, 50),
    recommendation: toRecommendation(raw?.recommendation),
  };

  // Save analysis artifact safely
  try {
    await base44.entities.AiArtifact.create({
      grant_id: grant.id,
      kind: 'analysis',
      content: JSON.stringify(analysisResult),
    });
  } catch (e) {
    console.warn('[aiAssessmentService] Failed to save AiArtifact:', e);
    // continue – analysis is still returned to caller
  }

  return analysisResult;
}

/**
 * Extract requirements checklist from grant URL
 * @param {Object} grant - Grant object
 * @returns {Promise<{created:number, method:string, items:any[]}>} summary of created items
 */
async function extractRequirements(grant) {
  const urlToParse = grant?.nofo_url || grant?.url;
  if (!urlToParse) return { created: 0, method: 'none', items: [] };

  // Validate URL (limit to http/https)
  let normalizedUrl;
  try {
    const u = new URL(urlToParse, typeof window !== 'undefined' ? window?.location?.origin : undefined);
    if (!/^https?:$/i.test(u.protocol)) {
      console.warn('[aiAssessmentService] Unsupported URL protocol:', u.protocol);
      return { created: 0, method: 'invalid-url', items: [] };
    }
    normalizedUrl = u.toString();
  } catch {
    console.warn('[aiAssessmentService] Invalid URL for extraction:', urlToParse);
    return { created: 0, method: 'invalid-url', items: [] };
  }

  const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
  if (!invokeLLM) {
    throw new Error('AI service unavailable for requirement extraction.');
  }

  const parsingPrompt = `Extract all proposal sections and required attachments from this URL:
${normalizedUrl}

Return a JSON object with:
- "proposal_sections": array of strings
- "required_attachments": array of strings`;

  const extracted = await invokeLLM({
    prompt: parsingPrompt,
    add_context_from_internet: true,
    response_json_schema: {
      type: 'object',
      properties: {
        proposal_sections: { type: 'array', items: { type: 'string' } },
        required_attachments: { type: 'array', items: { type: 'string' } },
      },
    },
  });

  const proposalSections = toStringArray(extracted?.proposal_sections, 100);
  const requiredAttachments = toStringArray(extracted?.required_attachments, 100);

  // Build checklist (cap total to prevent overload)
  const MAX_ITEMS = 50;
  const checklistItems = [
    ...proposalSections.map((title) => ({ grant_id: grant.id, title, type: 'task' })),
    ...requiredAttachments.map((title) => ({ grant_id: grant.id, title, type: 'doc' })),
  ].slice(0, MAX_ITEMS);

  const createdItems = [];

  for (const item of checklistItems) {
    try {
      const created = await base44.entities.ChecklistItem.create(item);
      createdItems.push(created);
      await sleep(50);
    } catch (err) {
      console.error('[aiAssessmentService] Failed to create checklist item:', item?.title, err);
    }
  }

  return { created: createdItems.length, method: 'sequential-safe', items: createdItems };
}

/**
 * Run complete AI assessment for a grant
 * @param {Object} grant - Grant object
 * @param {Object} organization - Organization object
 * @param {Object} options - Options
 * @param {boolean} options.skipIfExists - Skip if analysis already exists
 * @returns {Promise<Object>} Assessment result
 */
export async function runAIAssessment(grant, organization, options = {}) {
  const { skipIfExists = true } = options;

  // Validate inputs
  if (!grant?.id) throw new Error('Invalid grant object');
  if (!organization?.id) throw new Error('Invalid organization object');

  // Check if analysis already exists
  if (skipIfExists) {
    const exists = await hasExistingAnalysis(grant.id);
    if (exists) {
      return { skipped: true, reason: 'Analysis already exists' };
    }
  }

  // Run analysis
  const analysis = await runAnalysis(grant, organization);

  // Extract requirements
  const checklistResult = await extractRequirements(grant);

  return {
    success: true,
    analysis,
    checklistItemsCreated: checklistResult?.created || 0,
    checklistMethod: checklistResult?.method || 'unknown',
  };
}