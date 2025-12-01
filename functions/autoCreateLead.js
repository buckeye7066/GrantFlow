import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const { user } = payload;

    if (!user?.email) return Response.json({ created: false, reason: "No email" });

    const existing = await base44.entities.Lead.filter({ email: user.email });
    if (existing?.length > 0) return Response.json({ created: false, reason: "Already exists" });

    const first = user.first_name ?? user.full_name?.split(' ')[0] ?? user.email.split("@")[0];
    const last = user.last_name ?? user.full_name?.split(' ').slice(1).join(' ') ?? "";

    const newLead = await base44.entities.Lead.create({
      first_name: first, last_name: last, email: user.email,
      status: "new", priority: "medium", lead_source: "New User Auto-Create", assigned_to: null
    });

    return Response.json({ created: true, lead: newLead });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});