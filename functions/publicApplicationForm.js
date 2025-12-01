// NOTE: Large file (632 lines) with HTML form - minified
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  if (req.method === 'POST') {
    try {
      const formData = await req.json();
      if (!formData.name || !formData.email || !formData.applicant_type) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      const base44 = createClientFromRequest(req);
      const newOrg = await base44.asServiceRole.entities.Organization.create({
        name: formData.organization_name || formData.name, applicant_type: formData.applicant_type,
        city: formData.city, state: formData.state, mission: formData.mission
      });

      await base44.asServiceRole.integrations.Core.SendEmail({ to: formData.email, subject: 'Application Received', body: 'Thank you for applying.' });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // Return HTML form (632 lines minified)
  const html = '<!DOCTYPE html><html><head><title>GrantFlow Application</title></head><body><h1>GrantFlow Application Portal</h1><form id="form"><input name="name" required/><input name="email" required/><select name="applicant_type" required><option value="organization">Organization</option></select><button type="submit">Submit</button></form></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
});