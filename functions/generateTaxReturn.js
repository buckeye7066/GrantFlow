import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Generate Tax Return - Automated tax form generation
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { organization_id, tax_year } = body;
    if (!organization_id || !tax_year) return Response.json({ error: 'organization_id and tax_year required' }, { status: 400 });

    const organization = await sdk.entities.Organization.get(organization_id);
    const taxDocs = await sdk.entities.TaxDocument.filter({ organization_id, tax_year });
    const profiles = await sdk.entities.TaxProfile.filter({ organization_id, tax_year });
    const profile = profiles[0];
    if (!profile) return Response.json({ error: 'No tax analysis found. Run analysis first.' }, { status: 400 });

    const w2s = taxDocs.filter(d => d.document_type === 'w2');
    const wages = w2s.reduce((s, d) => s + (d.amount || 0), 0);
    const interest = taxDocs.filter(d => d.document_type === '1099_int').reduce((s, d) => s + (d.amount || 0), 0);

    const form1040 = {
      first_name: organization.name.split(' ')[0], last_name: organization.name.split(' ').slice(1).join(' '),
      address: organization.address, city: organization.city, state: organization.state, zip: organization.zip,
      filing_status: profile.filing_status, line_1z: wages, line_2b: interest, line_9: wages + interest,
      line_11: wages + interest, line_34: profile.estimated_refund || 0
    };

    const html = `<html><body><h1>Form 1040 - ${tax_year}</h1><p>Name: ${form1040.first_name} ${form1040.last_name}</p><p>Wages: $${wages}</p><p>Refund: $${profile.estimated_refund}</p></body></html>`;
    const blob = new TextEncoder().encode(html);
    const file = new File([blob], `tax-return-${tax_year}.html`, { type: 'text/html' });
    const { file_uri } = await sdk.integrations.Core.UploadPrivateFile({ file });

    const returnData = { organization_id, tax_year, return_type: '1040', status: 'draft', form_data: form1040, refund_amount: profile.estimated_refund, generated_pdf_uri: file_uri };
    const existing = await sdk.entities.TaxReturn.filter({ organization_id, tax_year });
    const saved = existing[0] ? await sdk.entities.TaxReturn.update(existing[0].id, returnData) : await sdk.entities.TaxReturn.create(returnData);

    return Response.json({ success: true, tax_return: saved, pdf_uri: file_uri });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});