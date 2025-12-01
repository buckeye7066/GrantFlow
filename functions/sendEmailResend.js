import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { to, subject, html, text, from_name } = await req.json();
    if (!to || !subject || (!html && !text)) return Response.json({ error: 'Missing required fields' }, { status: 400 });

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) return Response.json({ error: 'RESEND_API_KEY not configured' }, { status: 500 });

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from_name ? `${from_name} <onboarding@resend.dev>` : 'GrantFlow <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to], subject, html, text
      })
    });

    const result = await response.json();
    if (!response.ok) return Response.json({ error: result.message || 'Failed' }, { status: response.status });
    return Response.json({ success: true, id: result.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});