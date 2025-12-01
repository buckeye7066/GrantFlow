import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Crawl Benefits.gov - Federal benefits crawler
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { organization_id } = body;

    const prompt = `Search Benefits.gov for 15 federal assistance programs for low-income individuals/families. Return: name, agency, description, eligibility, assistance_type, url, benefit_amount, application_method.`;

    const ai = await sdk.integrations.Core.InvokeLLM({
      prompt, add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { programs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, agency: { type: "string" }, description: { type: "string" } } } } } }
    });

    const programs = ai.programs || [];
    let processed = 0;

    for (const p of programs) {
      if (!p.name) continue;
      const item = {
        source: 'benefits_gov', source_id: `bg_${Date.now()}_${processed}`, url: 'https://www.benefits.gov',
        title: p.name, sponsor: p.agency, description_raw: p.description, funding_type: 'federal_benefit',
        regions: ['USA'], categories: [p.assistance_type || 'assistance']
      };
      await sdk.functions.invoke('processCrawledItem', { item });
      processed++;
    }

    return Response.json({ ok: true, result: { status: 'completed', found: programs.length, processed } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});