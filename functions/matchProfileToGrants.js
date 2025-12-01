import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { scoreOpportunity } from './_shared/profileMatchingEngine.js';

createSafeServer(async (req) => {
  const requestId = crypto.randomUUID().slice(0,8);
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;

    let body = {};
    try { const text = await req.text(); if (text) body = JSON.parse(text); } catch (err) { return Response.json({ ok: false, error: 'INVALID_JSON' }, { status: 400 }); }

    const { profile_id, profile_data, limit = 100 } = body;
    const effectiveProfileId = profile_id || profile_data?.id;
    if (!effectiveProfileId) return Response.json({ ok: false, error: 'MISSING_PROFILE_ID' }, { status: 400 });

    let profile = profile_data;
    if (!profile) {
      try { profile = await sdk.entities.Organization.get(effectiveProfileId); } catch (e) { return Response.json({ ok: false, error: 'PROFILE_NOT_FOUND' }, { status: 404 }); }
    }

    const [profileOpps, nationalOpps] = await Promise.all([
      sdk.entities.FundingOpportunity.filter({ profile_id: effectiveProfileId }),
      sdk.entities.FundingOpportunity.filter({ is_national: true })
    ]);

    const seen = new Set();
    const opportunities = [];
    for (const opp of [...profileOpps, ...nationalOpps]) {
      if (!seen.has(opp.id)) { seen.add(opp.id); opportunities.push(opp); }
    }

    const scored = opportunities.map(opp => {
      const { score, matchedSections, reasons } = scoreOpportunity(opp, profile, { weights: { sectionWeight: 10, extraFieldWeight: 1, globalKeywordBoost: 1 } });
      return { ...opp, match: score, matchedSections, reasons };
    }).filter(r => r.match >= 50).sort((a,b) => b.match - a.match).slice(0, limit);

    return Response.json({ ok: true, data: scored, requestId });

  } catch (err) {
    console.error(`[matchProfileToGrants:${requestId}] ERROR:`, err?.message || err);
    return Response.json({ ok: false, error: err?.message || 'UNEXPECTED_ERROR' }, { status: 500});
  }
});
