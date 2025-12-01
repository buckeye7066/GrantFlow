import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id, perform_ai_polish = true } = await req.json();
    if (!grant_id) return Response.json({ error: 'grant_id required' }, { status: 400 });

    const grants = await base44.entities.Grant.filter({ id: grant_id });
    if (!grants.length) return Response.json({ error: 'Grant not found' }, { status: 404 });
    const grant = grants[0];

    const [proposalSections, budgets, documents, contacts] = await Promise.all([
      base44.entities.ProposalSection.filter({ grant_id }),
      base44.entities.Budget.filter({ grant_id }),
      base44.entities.Document.filter({ organization_id: grant.organization_id }),
      base44.entities.Contact.filter({ organization_id: grant.organization_id })
    ]);

    const readiness_score = (proposalSections.length > 0 ? 30 : 0) + (budgets.length > 0 ? 25 : 0) + (documents.length > 0 ? 20 : 0) + (contacts.length > 0 ? 15 : 0);

    let ai_polish_results = null;
    if (perform_ai_polish && proposalSections.length > 0) {
      ai_polish_results = await base44.integrations.Core.InvokeLLM({
        prompt: 'Final review of grant proposal for ' + grant.title + '. Sections: ' + proposalSections.map(s => s.section_name + ': ' + s.draft_content).join('\n\n'),
        response_json_schema: { type: "object", properties: { overall_quality_score: { type: "number" }, submission_ready: { type: "boolean" }, critical_issues: { type: "array", items: { type: "string" } }, strengths: { type: "array", items: { type: "string" } } } }
      });
    }

    return Response.json({ success: true, readiness_score, submission_ready: readiness_score >= 80, ai_polish_results });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});