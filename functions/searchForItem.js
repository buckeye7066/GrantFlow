// NOTE: Large file with PHI handling - minified
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { withDiagnostics } from './_shared/withDiagnostics.js';

const handler = async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  
  const sdk = base44.asServiceRole;
  const body = await req.json();
  const { item_request, profile_id, profile_data } = body;
  if (!item_request || !profile_id) return Response.json({ success: false, error: 'Missing params' }, { status: 400 });

  const profile = profile_data || await sdk.entities.Organization.get(profile_id);
  if (!profile) return Response.json({ success: false, error: 'Profile not found' }, { status: 404 });

  const aiResponse = await sdk.integrations.Core.InvokeLLM({
    prompt: 'Find funding for item: "' + item_request + '" for profile: ' + profile.name + ' in ' + profile.city + ', ' + profile.state,
    add_context_from_internet: true,
    response_json_schema: { type: "object", properties: { opportunities: { type: "array", items: { type: "object", properties: { program_name: { type: "string" }, sponsor: { type: "string" }, url: { type: "string" } } } } } }
  });

  return Response.json({ success: true, item_request, opportunities: aiResponse.opportunities || [] });
};

Deno.serve(withDiagnostics(handler, 'searchForItem'));