import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { source_id } = body;
    if (!source_id) return Response.json({ error: 'source_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const source = await sdk.entities.SourceDirectory.get(source_id);
    if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });

    const aiResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Find 3-5 scholarships from: ' + source.name + '. Return JSON with opportunities array.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { opportunities: { type: "array", items: { type: "object", properties: { title: { type: "string" }, amount_max: { type: "number" }, eligibility: { type: "string" }, deadline: { type: "string" } } } } } }
    });

    let saved = 0;
    for (const opp of (aiResponse?.opportunities || [])) {
      try {
        await sdk.functions.invoke('processCrawledItem', { item: { source: 'source_directory', source_id: source.id + '_' + Date.now(), title: opp.title, sponsor: source.name, url: source.website_url, description_raw: opp.eligibility, award_max: opp.amount_max } });
        saved++;
      } catch (e) {}
    }

    await sdk.entities.SourceDirectory.update(source_id, { last_crawled: new Date().toISOString(), opportunities_found: (source.opportunities_found || 0) + saved });
    return Response.json({ success: true, source_name: source.name, results: [{ opportunities_saved: saved }] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});