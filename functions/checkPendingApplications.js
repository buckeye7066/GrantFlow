import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const grantsToCheck = await base44.asServiceRole.entities.Grant.filter({ application_status: 'not_yet_open', notify_when_open: true });

    const results = [];
    for (const grant of grantsToCheck) {
      if (grant.application_next_check && new Date(grant.application_next_check) > new Date()) {
        results.push({ grant_id: grant.id, title: grant.title, skipped: true });
        continue;
      }

      try {
        const checkResp = await base44.asServiceRole.functions.invoke('checkApplicationAvailability', { grant_id: grant.id, force_check: true });
        results.push({ grant_id: grant.id, title: grant.title, ...checkResp });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        results.push({ grant_id: grant.id, title: grant.title, error: e.message });
      }
    }

    return Response.json({ success: true, total_checked: grantsToCheck.length, newly_opened: results.filter(r => r.is_open).length, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});