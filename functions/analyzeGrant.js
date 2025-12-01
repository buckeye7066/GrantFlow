import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Analyze Grant - AI-powered grant analysis with retry logic
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { grant_id, organization_id } = body;

    if (!grant_id) return Response.json({ ok: false, error: 'grant_id is required' }, { status: 400 });
    if (!organization_id) return Response.json({ ok: false, error: 'organization_id is required' }, { status: 400 });

    const grant = await sdk.entities.Grant.get(grant_id);
    const organization = await sdk.entities.Organization.get(organization_id);

    if (!grant) return Response.json({ ok: false, error: 'Grant not found' }, { status: 404 });
    if (!organization) return Response.json({ ok: false, error: 'Organization not found' }, { status: 404 });

    await sdk.entities.Grant.update(grant_id, { ai_status: 'running' });

    const prompt = `Analyze this funding opportunity.
OPPORTUNITY: Title: ${grant.title}, Funder: ${grant.funder}, Description: ${grant.program_description || 'N/A'}
APPLICANT: Name: ${organization.name}, Type: ${organization.applicant_type}, Location: ${organization.city}, ${organization.state}
Provide: fit_score (0-100), strengths, concerns, recommendations, summary.`;

    const aiResult = await sdk.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: { fit_score: { type: "number" }, strengths: { type: "array", items: { type: "string" } }, concerns: { type: "array", items: { type: "string" } }, summary: { type: "string" } }
      }
    });

    const summary = `**Match Score: ${aiResult.fit_score}/100**\n\n${aiResult.summary}\n\n**Strengths:** ${aiResult.strengths?.join(', ')}\n**Concerns:** ${aiResult.concerns?.join(', ')}`;

    await sdk.entities.Grant.update(grant_id, { ai_summary: summary, ai_status: 'ready', match_score: Math.round(aiResult.fit_score || 0) });

    return Response.json({ ok: true, result: { summary, analysis: aiResult } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});