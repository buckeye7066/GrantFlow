import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

const CONFIG = { MAX_RETRIES: 3, RETRY_DELAY_MS: 1000 };

function log(level, message, ctx = {}) {
  const sanitized = { ...ctx };
  if (sanitized.toEmail) { const [l, d] = sanitized.toEmail.split('@'); sanitized.toEmail = l.slice(0, 2) + '***@' + d; }
  console.log('[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] [sendInvoice] ' + message, Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : '');
}

async function retryWithBackoff(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { invoiceId, toEmail, subject, body: emailBody } = body;

    if (!invoiceId || !toEmail || !subject || !emailBody) {
      return Response.json({ success: false, error: { code: 'MISSING_FIELDS', message: 'invoiceId, toEmail, subject, body required' } }, { status: 400 });
    }

    // Verify invoice exists
    let invoice;
    try { invoice = await base44.asServiceRole.entities.Invoice.get(invoiceId); } catch (e) {}
    if (!invoice) return Response.json({ success: false, error: { code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' } }, { status: 404 });

    // Verify access
    let org;
    try { org = await base44.entities.Organization.get(invoice.organization_id); } catch (e) {}
    if (!org) return Response.json({ success: false, error: { code: 'ACCESS_DENIED', message: 'Access denied' } }, { status: 403 });

    // Send email
    await retryWithBackoff(() => base44.integrations.Core.SendEmail({ to: toEmail.trim(), subject: subject.trim(), body: emailBody }));

    // Update invoice status
    const updated = await retryWithBackoff(() => base44.asServiceRole.entities.Invoice.update(invoiceId, { status: 'Sent', sent_at: new Date().toISOString() }));

    return Response.json({ success: true, message: 'Invoice email sent', invoice: { id: updated.id, status: updated.status, sent_at: updated.sent_at } });
  } catch (error) {
    return Response.json({ success: false, error: { code: 'UNEXPECTED_ERROR', message: error.message } }, { status: 500 });
  }
});