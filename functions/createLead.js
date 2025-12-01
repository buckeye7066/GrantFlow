import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const { data } = payload;

    const newLead = await base44.entities.Lead.create(data);
    return Response.json(newLead);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});