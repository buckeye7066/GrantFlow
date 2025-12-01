import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Crawl Source Directory - AI research for funding opportunities
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { source_id } = body;

    if (!source_id) return Response.json({ error: 'source_id is required' }, { status: 400 });

    const source = await sdk.entities.SourceDirectory.get(source_id);
    if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });

    const prompt = `Research funding opportunities from ${source.name} (${source.source_type}).
Location: ${source.city}, ${source.state}. Focus: ${source.focus_areas?.join(', ') || 'General'}.
Find 3-5 current scholarships/grants with title, amount_min, amount_max, eligibility, deadline, description, url, confidence.`;

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { opportunities: { type: "array", items: { type: "object", properties: { title: { type: "string" }, amount_min: { type: "number" }, amount_max: { type: "number" }, eligibility: { type: "string" }, deadline: { type: "string" }, description: { type: "string" }, url: { type: "string" }, confidence: { type: "number" } } } } } }
    });

    let saved = 0;
    for (const opp of (aiResponse.opportunities || [])) {
      try {
        await sdk.functions.invoke('processCrawledItem', {
          item: { source: 'source_directory', title: opp.title, sponsor: source.name, url: opp.url || source.website_url, awardMin: opp.amount_min, awardMax: opp.amount_max, deadlineAt: opp.deadline, description_raw: opp.description }
        });
        saved++;
      } catch (e) {}
    }

    await sdk.entities.SourceDirectory.update(source_id, { last_crawled: new Date().toISOString(), opportunities_found: (source.opportunities_found || 0) + saved });

    return Response.json({ success: true, source_name: source.name, results: [{ opportunities_saved: saved, method: 'ai_research' }] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});