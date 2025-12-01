import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Queue Crawl - Dispatcher for crawler functions
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { sourceName } = body;
    if (!sourceName) return Response.json({ success: false, error: 'sourceName required' }, { status: 400 });

    const adapters = { benefits_gov: 'crawlBenefitsGov', dsire: 'crawlDSIRE', grants_gov: 'crawlGrantsGov' };
    const adapter = adapters[sourceName];
    if (!adapter) return Response.json({ error: `No adapter for ${sourceName}` }, { status: 400 });

    const result = await sdk.functions.invoke(adapter, {});
    return Response.json({ success: true, message: `Crawl queued for ${sourceName}`, result: result.data });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});