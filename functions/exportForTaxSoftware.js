import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Export for Tax Software - TXF/XML export for TurboTax/ProSeries
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { tax_return_id, export_format = 'turbotax_txf' } = body;
    if (!tax_return_id) return Response.json({ error: 'tax_return_id required' }, { status: 400 });

    const taxReturn = await sdk.entities.TaxReturn.get(tax_return_id);
    const organization = await sdk.entities.Organization.get(taxReturn.organization_id);
    const form = taxReturn.form_data || {};

    let exportData, filename, contentType;
    if (export_format === 'csv') {
      exportData = `Form,Line,Description,Amount\n1040,1,Wages,${form.line_1z || 0}\n1040,11,AGI,${form.line_11 || 0}\n1040,34,Refund,${taxReturn.refund_amount || 0}`;
      filename = `tax-data-${taxReturn.tax_year}.csv`;
      contentType = 'text/csv';
    } else {
      exportData = `V042\nA${organization.name}\nD ${new Date().toLocaleDateString()}\n^`;
      filename = `tax-return-${taxReturn.tax_year}.txf`;
      contentType = 'text/plain';
    }

    const blob = new TextEncoder().encode(exportData);
    const file = new File([blob], filename, { type: contentType });
    const { file_uri } = await sdk.integrations.Core.UploadPrivateFile({ file });
    const { signed_url } = await sdk.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 3600 });

    return Response.json({ success: true, download_url: signed_url, filename, format: export_format });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});