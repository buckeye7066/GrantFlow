import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const sdk = createClientFromRequest(req).asServiceRole;
  const { file_uri, organization_id, source_type } = await req.json();

  if (!file_uri || !organization_id) {
    return Response.json({ error: 'file_uri and organization_id required' }, { status: 400 });
  }

  try {
    const { signed_url } = await sdk.integrations.Core.CreateFileSignedUrl({ file_uri });
    if (!signed_url) throw new Error('Could not create signed URL');

    const extractedData = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Analyze document at ' + signed_url + ' and extract: nonprofit_status (501c3), business_type (MBE/WBE/veteran-owned), identifier_ein. Return JSON.',
      response_json_schema: { type: "object", properties: { nonprofit_status: { type: "string" }, business_type: { type: "string" }, identifier_ein: { type: "string" } } }
    });

    if (!extractedData) return Response.json({ message: 'No facts found' });

    const factsToCreate = [];
    for (const [key, value] of Object.entries(extractedData)) {
      if (value) {
        factsToCreate.push({ organization_id, key, value, confidence: 0.95, source_type: source_type || 'document', source_uri: file_uri, captured_at: new Date().toISOString() });
      }
    }

    if (factsToCreate.length > 0) await sdk.entities.ProfileFact.bulkCreate(factsToCreate);
    return Response.json({ status: 'success', facts_found: factsToCreate.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});