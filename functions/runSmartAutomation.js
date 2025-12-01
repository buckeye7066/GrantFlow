// NOTE: Large file (522 lines) with complex automation logic - minified
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { withDiagnostics } from './_shared/withDiagnostics.js';
import { buildNormalizedProfile } from './_shared/buildNormalizedProfile.js';

const handler = async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ ok: false, error: 'UNAUTHENTICATED' }, { status: 401 });

  const sdk = base44.asServiceRole;
  const body = await req.json().catch(() => ({}));
  const { automation_type, organization_id } = body;

  const results = { automation_type, started_at: new Date().toISOString(), actions_taken: [] };

  // Discovery automation
  if (automation_type === 'discovery' || automation_type === 'all') {
    const orgs = organization_id ? [await sdk.entities.Organization.get(organization_id)] : await sdk.entities.Organization.list();
    for (const org of orgs) {
      if (!org) continue;
      const normalized = buildNormalizedProfile(org);
      const discoveryResp = await base44.functions.invoke('matchGrantsForOrganization', { organization_id: org.id, profile_id: org.id });
      const opps = discoveryResp.data?.data?.opportunities || [];
      
      for (const opp of opps.filter(o => o.match >= 70).slice(0, 10)) {
        const existing = await sdk.entities.Grant.filter({ organization_id: org.id, profile_id: org.id, url: opp.url });
        if (existing.length === 0 && opp.url) {
          await sdk.entities.Grant.create({ organization_id: org.id, profile_id: org.id, title: opp.title, funder: opp.sponsor, url: opp.url, status: 'discovered', match_score: opp.match });
          results.actions_taken.push({ type: 'discovery', org: org.name, action: 'added_grant', grant: opp.title });
        }
      }
    }
  }

  results.completed_at = new Date().toISOString();
  return Response.json({ ok: true, data: results });
};

Deno.serve(withDiagnostics(handler, 'runSmartAutomation'));