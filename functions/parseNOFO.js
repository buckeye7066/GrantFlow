import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const CONFIG = { FETCH_TIMEOUT_MS: 30000, MAX_CONTENT_LENGTH: 50000, MIN_VALID_CONTENT_LENGTH: 100 };

function log(level, message, ctx = {}) {
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [parseNOFO] ' + message, Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '');
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { file_url, json_schema, is_url } = body;

    if (!file_url || !json_schema) {
      return Response.json({ success: false, error: { code: 'MISSING_FIELDS', message: 'file_url and json_schema required' } }, { status: 400 });
    }

    let extractedData;
    if (is_url) {
      // Fetch webpage
      const response = await fetch(file_url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error('Failed to fetch: ' + response.status);
      const html = await response.text();
      const cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      if (cleanHtml.length < CONFIG.MIN_VALID_CONTENT_LENGTH) throw new Error('Content too short');

      const truncated = cleanHtml.length > CONFIG.MAX_CONTENT_LENGTH ? cleanHtml.substring(0, CONFIG.MAX_CONTENT_LENGTH) + '...' : cleanHtml;

      extractedData = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: 'Extract grant information from this webpage. URL: ' + file_url + '\n\nContent:\n' + truncated,
        response_json_schema: json_schema
      });
    } else {
      // Process file
      extractedData = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: 'Extract grant information from the attached document. Return structured JSON.',
        response_json_schema: json_schema,
        file_urls: [file_url]
      });
    }

    if (!extractedData || typeof extractedData !== 'object') {
      return Response.json({ success: false, error: { code: 'INVALID_RESULT', message: 'AI returned invalid response' } }, { status: 500 });
    }

    return Response.json({ success: true, status: 'success', output: extractedData, metadata: { requestId, processingMode: is_url ? 'URL' : 'FILE', timestamp: new Date().toISOString() } });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});