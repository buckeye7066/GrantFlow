import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Analyze Grant - Robust grant analysis with contamination guards
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'UNAUTHENTICATED', skipped: true, score: 0 }, { status: 401 });

    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { grant_id, profile_id, organization_id, opportunity } = body;

    if (!grant_id) return Response.json({ error: 'missing_grant_id', skipped: true, score: 0 }, { status: 400 });
    if (!profile_id) return Response.json({ error: 'missing_profile_id', skipped: true, score: 0 }, { status: 400 });

    const profile = await sdk.entities.Organization.get(profile_id);
    if (!profile) return Response.json({ error: 'profile_not_found', skipped: true, score: 0 }, { status: 404 });

    let opp = opportunity;
    if (!opp) {
      const grant = await sdk.entities.Grant.get(grant_id);
      if (grant) opp = { id: grant.id, title: grant.title, sponsor: grant.funder, descriptionMd: grant.program_description };
    }
    if (!opp) return Response.json({ error: 'grant_not_found', skipped: true, score: 0 }, { status: 404 });

    let score = 50;
    const reasons = [];
    const oppText = `${opp.title} ${opp.descriptionMd || ''}`.toLowerCase();

    if (profile.applicant_type?.includes('student') && oppText.includes('student')) { score += 15; reasons.push('Student eligibility'); }
    if (profile.keywords?.some(k => oppText.includes(k.toLowerCase()))) { score += 10; reasons.push('Keyword match'); }

    return Response.json({ success: true, score: Math.min(100, score), reasons, opportunity: { id: opp.id, title: opp.title }, profile: { id: profile.id, name: profile.name }, skipped: false });
  } catch (error) {
    return Response.json({ error: error.message, skipped: true, score: 0 }, { status: 500 });
  }
});