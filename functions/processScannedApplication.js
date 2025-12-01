import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Process Scanned Application - OCR and AI extraction from uploaded forms
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { file_url, organization_id } = body;

    if (!file_url) return Response.json({ success: false, error: 'file_url required' }, { status: 400 });

    const prompt = `Extract ALL information from this application form. Return as JSON with fields: name (REQUIRED), applicant_type, date_of_birth, email (array), phone (array), address, city, state, zip, household_income, primary_goal, special_circumstances, keywords (array).`;

    const extracted = await base44.integrations.Core.InvokeLLM({
      prompt, file_urls: file_url,
      response_json_schema: { type: "object", properties: { name: { type: "string" }, applicant_type: { type: "string" }, email: { type: "array", items: { type: "string" } }, phone: { type: "array", items: { type: "string" } }, city: { type: "string" }, state: { type: "string" } } }
    });

    if (!extracted?.name) return Response.json({ success: false, error: 'Could not find name on form' }, { status: 400 });

    const emails = Array.isArray(extracted.email) ? extracted.email : [];
    const phones = Array.isArray(extracted.phone) ? extracted.phone : [];
    delete extracted.email;
    delete extracted.phone;

    let savedOrg;
    if (organization_id) {
      savedOrg = await base44.entities.Organization.update(organization_id, extracted);
    } else {
      savedOrg = await base44.entities.Organization.create(extracted);
    }

    for (const email of emails) {
      await base44.entities.ContactMethod.create({ organization_id: savedOrg.id, type: 'email', value: email });
    }
    for (const phone of phones) {
      await base44.entities.ContactMethod.create({ organization_id: savedOrg.id, type: 'phone', value: phone });
    }

    return Response.json({ success: true, organization: savedOrg });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});