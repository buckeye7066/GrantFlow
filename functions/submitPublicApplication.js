import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const formData = await req.json();
    if (!formData.name || !formData.email || !formData.applicant_type) {
      return Response.json({ success: false, error: 'Missing required: name, email, applicant_type' }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);
    const orgData = { name: String(formData.organization_name || formData.name).trim(), applicant_type: String(formData.applicant_type).trim() };
    
    const emailStr = formData.email ? String(formData.email).trim() : '';
    if (emailStr?.includes('@')) orgData.email = emailStr;
    
    if (formData.city) orgData.city = String(formData.city).trim();
    if (formData.state) orgData.state = String(formData.state).trim();
    if (formData.mission) orgData.mission = String(formData.mission).trim();

    const newOrg = await base44.asServiceRole.entities.Organization.create(orgData);

    if (formData.email) {
      await base44.asServiceRole.entities.ContactMethod.create({ organization_id: newOrg.id, type: 'email', value: formData.email, primary: true });
    }

    await base44.asServiceRole.integrations.Core.SendEmail({
      to: formData.email, subject: 'Application Received - GrantFlow',
      body: 'Thank you ' + formData.name + '. We will contact you within 1-2 business days. - Dr. John White'
    });

    await base44.asServiceRole.integrations.Core.SendEmail({
      to: 'buckeye7066@gmail.com', subject: 'NEW APPLICATION: ' + formData.name,
      body: 'New application from ' + formData.name + ' (' + formData.email + '). Profile ID: ' + newOrg.id
    });

    return Response.json({ success: true, organization_id: newOrg.id, message: 'Application submitted successfully' });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});