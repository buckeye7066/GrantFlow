import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const currentUser = await base44.auth.me();
    if (!currentUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { userId } = await req.json();
    if (!userId) return Response.json({ error: 'User ID required' }, { status: 400 });
    if (userId === currentUser.id) return Response.json({ error: 'Cannot delete your own account' }, { status: 400 });

    await base44.asServiceRole.entities.User.delete(userId);
    return Response.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});