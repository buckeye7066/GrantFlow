import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const rawText = await req.text();
    const contentType = req.headers.get('content-type') || '';
    
    let emailData = {};
    if (contentType.includes('application/json')) {
      emailData = JSON.parse(rawText);
    } else {
      emailData = { body: rawText, text: rawText };
    }

    const from = emailData.from || emailData.email || '';
    const subject = emailData.subject || '';
    const body = emailData.text || emailData.body || '';

    const extractedData = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: 'Extract application info from email. Subject: ' + subject + '. Body: ' + body + '. Return JSON with: name, email, phone, applicant_type, city, state, mission.',
      response_json_schema: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, applicant_type: { type: "string" }, city: { type: "string" }, state: { type: "string" }, mission: { type: "string" }, is_application: { type: "boolean" } } }
    });

    if (!extractedData.is_application || !extractedData.name) {
      return Response.json({ success: true, message: 'Not an application', skipped: true });
    }

    const newOrg = await base44.asServiceRole.entities.Organization.create({
      name: extractedData.name, applicant_type: extractedData.applicant_type || 'other',
      city: extractedData.city, state: extractedData.state, mission: extractedData.mission
    });

    if (extractedData.email) {
      await base44.asServiceRole.entities.ContactMethod.create({ organization_id: newOrg.id, type: 'email', value: extractedData.email, primary: true });
    }

    await base44.asServiceRole.integrations.Core.SendEmail({ to: 'buckeye7066@gmail.com', subject: '🤖 AUTO-CREATED: ' + extractedData.name, body: 'Auto-created from email. Profile: ' + newOrg.id });

    return Response.json({ success: true, organization_id: newOrg.id, extracted_data: extractedData });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});