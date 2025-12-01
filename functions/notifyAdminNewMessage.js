import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { messageId } = await req.json();
    const messages = await base44.entities.Message.filter({ id: messageId });
    if (!messages?.length) return Response.json({ error: 'Message not found' }, { status: 404 });

    const message = messages[0];
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