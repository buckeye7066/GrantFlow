import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { tax_return_id, export_format } = body;
    if (!tax_return_id) return Response.json({ error: 'tax_return_id required' }, { status: 400 });

    const taxReturn = await base44.entities.TaxReturn.get(tax_return_id);
    const organization = await base44.entities.Organization.get(taxReturn.organization_id);

    let exportedData, filename, contentType;
    const form = taxReturn.form_data || {};

    if (export_format === 'csv') {
      exportedData = 'Form,Line,Description,Amount\n1040,1,Wages,' + (form.line_1z || 0) + '\n1040,11,AGI,' + (form.line_11 || 0);
      filename = 'tax-data-' + taxReturn.tax_year + '.csv';
      contentType = 'text/csv';
    } else {
      // TXF format (default)
      exportedData = 'V042\nA' + organization.name + '\nD ' + new Date().toLocaleDateString() + '\n^\nTD\nN1\nC1\nL1\n$' + (form.line_1z || 0) + '\nD ' + taxReturn.tax_year + '-12-31\n^';
      filename = 'tax-return-' + taxReturn.tax_year + '.txf';
      contentType = 'text/plain';
    }

    const file = new File([new TextEncoder().encode(exportedData)], filename, { type: contentType });
    const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });
    const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 3600 });

    return Response.json({ success: true, download_url: signed_url, filename, format: export_format || 'txf' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});