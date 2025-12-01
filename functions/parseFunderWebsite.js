import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const { url, funder_name, force_refresh = false, test_mode = false } = await req.json();

    if (test_mode) return Response.json({ success: true, metadata: { funder_name, test_only: true }, test_mode: true });
    if (!url || !funder_name) return Response.json({ success: false, error: 'Missing url and funder_name' }, { status: 400 });

    if (!force_refresh) {
      const existing = await sdk.entities.FunderMetadata.filter({ funder_name });
      if (existing.length > 0) {
        const days = (Date.now() - new Date(existing[0].last_parsed).getTime()) / 86400000;
        if (days < 30) return Response.json({ success: true, metadata: existing[0], cached: true });
      }
    }

    const parsedData = await sdk.integrations.Core.InvokeLLM({
      prompt: `Analyze funder website ${funder_name} at ${url}. Extract mission, priorities, eligibility, funding structure.`,
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { mission_keywords: { type: "array", items: { type: "string" } }, population_focus: { type: "array", items: { type: "string" } } } }
    });

    const existing = await sdk.entities.FunderMetadata.filter({ funder_name });
    const record = { funder_name, funder_url: url, ...parsedData, last_parsed: new Date().toISOString() };
    const saved = existing.length > 0 ? await sdk.entities.FunderMetadata.update(existing[0].id, record) : await sdk.entities.FunderMetadata.create(record);

    return Response.json({ success: true, metadata: saved, cached: false });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});