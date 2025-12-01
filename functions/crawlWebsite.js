import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { CRAWLER_TIMEOUT_MS: 40000, FETCH_TIMEOUT_MS: 15000, MAX_HTML_LENGTH: 60000 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [crawlWebsite] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

Deno.serve(async (req) => {
  const crawlId = crypto.randomUUID().slice(0, 8);
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { url, source_name, organization_id } = body;

    if (!url || !source_name) {
      return Response.json({ ok: false, error: 'Missing url and source_name' }, { status: 400 });
    }

    let logEntry = null;
    try { logEntry = await sdk.entities.CrawlLog.create({ source: 'website: ' + source_name, status: 'started' }); } catch (e) {}

    // Fetch content
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
    let htmlContent = '';
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrantFlow/1.0)' }, signal: controller.signal });
      clearTimeout(fetchTimeout);
      if (!response.ok) throw new Error('Website returned ' + response.status);
      htmlContent = await response.text();
    } catch (e) {
      clearTimeout(fetchTimeout);
      throw new Error('Fetch failed: ' + e.message);
    }

    // Extract with AI
    const extractedData = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Analyze this page and extract funding opportunities. URL: ' + url + '\n\nHTML (first ' + CONFIG.MAX_HTML_LENGTH + ' chars):\n' + htmlContent.substring(0, CONFIG.MAX_HTML_LENGTH),
      response_json_schema: { type: "object", properties: { opportunities: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, amount: { type: "number" }, deadline: { type: "string" } } } } } }
    });

    const opportunities = extractedData?.opportunities || [];
    let processed = 0;
    for (const opp of opportunities) {
      try {
        const sourceId = source_name + '_' + (opp.title || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        await sdk.functions.invoke('processCrawledItem', { item: { source: source_name, source_id: sourceId, title: opp.title || 'Untitled', sponsor: source_name, url: url, description_raw: opp.description || '', close_date: opp.deadline, award_max: opp.amount } });
        processed++;
      } catch (e) { log('error', 'Failed item', { error: e.message }); }
    }

    if (logEntry) try { await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: opportunities.length, recordsAdded: processed }); } catch (e) {}
    return Response.json({ ok: true, result: { status: 'completed', source: source_name, found: opportunities.length, processed } });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message ?? 'Crawler error' }, { status: 500 });
  }
});