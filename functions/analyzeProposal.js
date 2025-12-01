import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id, section_id, content } = await req.json();
    if (!grant_id || !content) return Response.json({ error: 'grant_id and content required' }, { status: 400 });

    const grants = await base44.entities.Grant.filter({ id: grant_id });
    if (!grants.length) return Response.json({ error: 'Grant not found' }, { status: 404 });
    const grant = grants[0];

    const analysis = await base44.integrations.Core.InvokeLLM({
      prompt: 'Analyze proposal section for grant: ' + grant.title + ' from ' + grant.funder + '. Content: ' + content.substring(0, 1000) + '. Return JSON with overall_score, strengths, weaknesses, clarity_score, alignment_score, actionable_improvements.',
      response_json_schema: { type: "object", properties: { overall_score: { type: "number" }, strengths: { type: "array", items: { type: "string" } }, weaknesses: { type: "array", items: { type: "string" } }, clarity_score: { type: "number" }, alignment_score: { type: "number" }, actionable_improvements: { type: "array", items: { type: "string" } } } }
    });

    return Response.json({ success: true, analysis });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});