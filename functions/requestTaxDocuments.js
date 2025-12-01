import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Request Tax Documents - Email requests to employers/banks for tax forms
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, institution_name, institution_email, connection_type, tax_year } = body;
    if (!organization_id || !institution_name || !institution_email) return Response.json({ error: 'organization_id, institution_name, institution_email required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    const year = tax_year || new Date().getFullYear();

    const connection = await sdk.entities.TaxDocumentConnection.create({
      organization_id, connection_type, institution_name, institution_contact_email: institution_email,
      connection_method: 'email_request', connection_status: 'pending', email_sent_date: new Date().toISOString()
    });

    const docType = connection_type === 'employer_w2' ? 'W-2' : connection_type.includes('1099') ? connection_type.replace('_', ' ').toUpperCase() : 'Tax Document';
    const subject = `Tax Document Request - ${docType} for ${year}`;
    const body_text = `Dear ${institution_name},\n\nI am requesting my ${docType} for tax year ${year}.\n\nName: ${organization.name}\nAddress: ${organization.address}, ${organization.city}, ${organization.state} ${organization.zip}\n\nPlease send to: ${organization.created_by}\n\nThank you,\n${organization.name}`;

    await sdk.integrations.Core.SendEmail({ to: institution_email, subject, body: body_text });
    return Response.json({ success: true, connection_id: connection.id, message: `Request sent to ${institution_name}` });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});