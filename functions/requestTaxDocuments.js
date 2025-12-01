import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = { id: 'public', email: 'public@grantflow.app', full_name: 'Public User' };
    const body = await req.json();
    const { organization_id, institution_name, institution_email, connection_type, tax_year } = body;
    
    if (!organization_id || !institution_name || !institution_email) {
      return Response.json({ error: 'organization_id, institution_name, and institution_email required' }, { status: 400 });
    }

    const organization = await base44.entities.Organization.get(organization_id);
    const currentYear = tax_year || new Date().getFullYear();

    const connection = await base44.entities.TaxDocumentConnection.create({
      organization_id, connection_type, institution_name, institution_contact_email: institution_email,
      connection_method: 'email_request', connection_status: 'pending', email_sent_date: new Date().toISOString()
    });

    await base44.integrations.Core.SendEmail({
      from_name: 'GrantFlow Tax Center', to: institution_email,
      subject: 'Tax Document Request - ' + connection_type + ' for ' + currentYear,
      body: '<h2>Tax Document Request</h2><p>Dear ' + institution + ',</p><p>Requesting ' + connection_type + ' for ' + organization.name + ' for tax year ' + currentYear + '.</p><p>Send to: ' + user.email + '</p>'
    });

    return Response.json({ success: true, connection_id: connection.id, message: 'Document request sent to ' + institution_name });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});