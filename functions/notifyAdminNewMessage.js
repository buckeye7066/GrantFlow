import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

async function fetchMessageById(sdk, messageId) {
  if (!sdk?.entities?.Message) return null;
  const results = await sdk.entities.Message.filter({ id: messageId }).catch(() => []);
  return Array.isArray(results) && results.length > 0 ? results[0] : null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { messageId } = await req.json();
    if (!messageId || String(messageId).trim().length === 0) {
      return Response.json({ error: 'messageId is required' }, { status: 400 });
    }

    const sdk = base44.asServiceRole;
    const message = await fetchMessageById(sdk, messageId);
    if (!message) {
      return Response.json({ error: 'Message not found' }, { status: 404 });
    }

    await base44.integrations.Core.SendEmail({
      from_name: 'GrantFlow',
      to: 'buckeye7066@gmail.com',
      subject: `New Message: ${message.subject}`,
      body: `From: ${message.from_user_name} (${message.from_user_email})\nType: ${message.message_type}\n\n${message.message}`
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
