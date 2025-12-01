// NOTE: This is a VERY LARGE file (1081 lines) - minified for GitHub backup
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => ({ id: 'system', email: 'system@grantflow.app' }));
  
  try {
    const body = await req.json();
    const { file_url, organization_id } = body;
    if (!file_url) return Response.json({ success: false, error: 'file_url required' }, { status: 200 });

    // AI extraction with comprehensive schema (700+ lines of schema)
    const extractedData = await base44.integrations.Core.InvokeLLM({
      prompt: 'Extract ALL data from this application form. Look EVERYWHERE for name. Return only JSON.',
      file_urls: file_url,
      response_json_schema: { type: "object", properties: { name: { type: "string" }, applicant_type: { type: "string" } /* ... 100+ fields ... */ } }
    });

    if (!extractedData?.name && !organization_id) {
      return Response.json({ success: false, error: 'Could not find name', details: 'Take clearer photo with good lighting' }, { status: 200 });
    }

    const savedOrganization = organization_id 
      ? await base44.entities.Organization.update(organization_id, extractedData)
      : await base44.entities.Organization.create(extractedData);

    return Response.json({ success: true, organization: savedOrganization });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});