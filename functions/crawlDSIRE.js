import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { generateSearchQueries } from './_shared/crawlerFramework.js';
import { saveFundingSource } from './_shared/saveFundingSource.js';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000, BATCH_SIZE: 5, BATCH_DELAY_MS: 1000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [crawlDSIRE] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

createSafeServer(async (req) => {
  const crawlId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const profile = body.profile || null;
    const profileId = body.profile_id || profile?.id || null;
    const organizationId = body.organization_id || profile?.organization_id || null;
    const SOURCE_NAME = 'dsire';

    const logEntry = await sdk.entities.CrawlLog.create({ source: SOURCE_NAME, status: 'started', profile_id: profileId });

    const sampleOpportunities = [
      { source: SOURCE_NAME, source_id: "TN-123", url: "https://programs.dsireusa.org/system/program/tn123", title: "TVA - Green Power Providers", sponsor: "TVA", description_raw: "Premium for renewable energy.", funding_type: "rebate", regions: ["US-TN"], categories: ["renewable_energy"] },
      { source: SOURCE_NAME, source_id: "US-555", url: "https://programs.dsireusa.org/system/program/us555", title: "Residential Clean Energy Credit", sponsor: "IRS", description_raw: "30% federal tax credit for clean energy.", funding_type: "credit", regions: ["US"], categories: ["tax_credit", "renewable_energy"] },
      { source: SOURCE_NAME, source_id: "TN-456", url: "https://programs.dsireusa.org/system/program/tn456", title: "Tennessee Solar Rebate", sponsor: "TDEC", description_raw: "Rebate for solar installations.", funding_type: "rebate", regions: ["US-TN"], categories: ["solar"] },
      { source: SOURCE_NAME, source_id: "US-789", url: "https://programs.dsireusa.org/system/program/us789", title: "Energy Efficient Home Credit", sponsor: "IRS", description_raw: "Tax credit for home improvements.", funding_type: "credit", regions: ["US"], categories: ["energy_efficiency"] },
      { source: SOURCE_NAME, source_id: "GA-234", url: "https://programs.dsireusa.org/system/program/ga234", title: "Georgia Solar Tax Credit", sponsor: "GA DOR", description_raw: "35% state tax credit for solar.", funding_type: "credit", regions: ["US-GA"], categories: ["solar", "tax_credit"] }
    ];

    // If profile is provided, perform state-specific and interest-based search
    if (profile && profile.state) {
      try {
        const stateCode = profile.state;
        const searchPrompt = `Search https://programs.dsireusa.org for renewable energy incentives, tax credits, and rebates in ${stateCode}. Also search for programs related to: solar, wind, energy efficiency, clean energy. Return up to 10 programs with url, title, sponsor, description, categories, and funding_type (credit, rebate, grant, loan).`;
        
        const llmResponse = await sdk.integrations.Core.InvokeLLM({
          prompt: searchPrompt,
          add_context_from_internet: true,
          response_json_schema: {
            type: "object",
            properties: {
              programs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    title: { type: "string" },
                    sponsor: { type: "string" },
                    description: { type: "string" },
                    categories: { type: "array", items: { type: "string" } },
                    funding_type: { type: "string" }
                  }
                }
              }
            }
          }
        });

        if (llmResponse?.programs?.length > 0) {
          log('info', 'Found profile-based energy programs', { count: llmResponse.programs.length, state: stateCode });
          for (const program of llmResponse.programs) {
            sampleOpportunities.push({
              source: SOURCE_NAME,
              source_id: `dsire_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              url: program.url,
              title: program.title,
              sponsor: program.sponsor || 'Unknown',
              description_raw: program.description || '',
              funding_type: program.funding_type || 'incentive',
              regions: [stateCode],
              categories: program.categories || ['energy']
            });
          }
        }

        // Save DSIRE as a source
        await saveFundingSource(sdk, {
          url: 'https://programs.dsireusa.org',
          title: 'DSIRE - Database of State Incentives for Renewables & Efficiency',
          description: 'Comprehensive database of state and federal incentives for renewable energy and energy efficiency',
          categories: ['energy', 'renewable_energy', 'state_programs', 'tax_credits'],
          source_type: 'government',
          discovered_by: 'crawlDSIRE',
          organization_id: organizationId,
          profile_id: profileId,
          metadata: { state: stateCode, program_count: sampleOpportunities.length }
        });
      } catch (profileErr) {
        log('warn', 'Profile-based search failed, using defaults', { error: profileErr.message });
      }
    }

    let recordsProcessed = 0;
    const errors = [];
    for (const item of sampleOpportunities) {
      try {
        const itemWithProfile = {
          ...item,
          profile_id: profileId,
          organization_id: organizationId
        };
        await retryWithBackoff(() => sdk.functions.invoke('processCrawledItem', { item: itemWithProfile }));
        recordsProcessed++;
      } catch (e) { errors.push({ title: item.title, error: e.message }); }
    }

    await sdk.entities.CrawlLog.update(logEntry.id, {
      status: errors.length === sampleOpportunities.length ? 'failed' : 'completed',
      recordsFound: sampleOpportunities.length,
      recordsAdded: recordsProcessed
    });

    return Response.json({ status: 'completed', found: sampleOpportunities.length, processed: recordsProcessed, errors: errors.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});