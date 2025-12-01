import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const activities = await base44.entities.Activity.list('-created_date');
    return Response.json(activities || []);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});