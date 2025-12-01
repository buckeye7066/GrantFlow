import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';
import { z } from 'npm:zod@3.23.8';

const Schema = z.object({ jobId: z.string().uuid() });

Deno.serve(async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const base44 = createClientFromRequest(req);
    if (req.method !== 'POST') return new Response(JSON.stringify({ message: 'Method Not Allowed' }), { status: 405, headers });

    const body = await req.json().catch(() => ({}));
    const parsed = Schema.safeParse(body);
    if (!parsed.success) return new Response(JSON.stringify({ message: 'Invalid input', errors: parsed.error.flatten() }), { status: 400, headers });

    const job = await base44.asServiceRole.entities.SearchJob.get(parsed.data.jobId);
    if (!job) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });

    return new Response(JSON.stringify(job), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ message: 'Internal Server Error', error: e.message }), { status: 500, headers });
  }
});