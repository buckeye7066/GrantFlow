import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const currentUser = await base44.auth.me();
    if (!currentUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const users = await base44.asServiceRole.entities.User.list();

    const usersWithActivity = await Promise.all(users.map(async (u) => {
      const [organizations, grants, documents] = await Promise.all([
        base44.asServiceRole.entities.Organization.filter({ created_by: u.email }),
        base44.asServiceRole.entities.Grant.filter({ created_by: u.email }),
        base44.asServiceRole.entities.Document.filter({ created_by: u.email })
      ]);

      return {
        id: u.id, email: u.email, full_name: u.full_name, role: u.role, created_date: u.created_date,
        activity: { organizations: organizations.length, grants: grants.length, documents: documents.length, total_actions: organizations.length + grants.length + documents.length }
      };
    }));

    return Response.json({ success: true, count: users.length, users: usersWithActivity });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});