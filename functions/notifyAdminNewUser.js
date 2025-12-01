import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { userEmail, userName } = await req.json();
    if (!userEmail) return Response.json({ error: 'User email required' }, { status: 400 });

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) return Response.json({ error: 'Email service not configured' }, { status: 500 });

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'GrantFlow <onboarding@resend.dev>', to: ['buckeye7066@gmail.com'],
        subject: '🎉 New User Signup - GrantFlow',
        html: '<h2>New User Signup</h2><p>Name: ' + userName + '</p><p>Email: ' + userEmail + '</p><p>Date: ' + new Date().toLocaleString() + '</p>'
      })
    });

    if (!response.ok) return Response.json({ error: 'Failed to send notification' }, { status: 500 });
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});