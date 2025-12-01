import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const { id, data } = payload;

    if (!id) return Response.json({ error: "No id provided" }, { status: 400 });

    const updated = await base44.entities.Lead.update(id, data);
    return Response.json(updated);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});