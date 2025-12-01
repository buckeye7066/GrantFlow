import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const { id } = payload;

    if (!id) return Response.json(null);

    const lead = await base44.entities.Lead.get(id);
    return Response.json(lead);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});