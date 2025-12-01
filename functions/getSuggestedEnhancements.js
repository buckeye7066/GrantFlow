import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const input = await req.json().catch(() => ({}));
    const { profileId, profile_id, organizationId, organization_id, selfCheck } = input;

    if (selfCheck) return Response.json({ ok: true, data: 'selfCheck passed' });

    const lookupId = profileId || profile_id || organizationId || organization_id;
    if (!lookupId) return Response.json({ ok: false, error: 'Missing profileId/organizationId' });

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Authentication required' });

    const sdk = base44.asServiceRole;
    const results = await sdk.entities.Organization.filter({ id: lookupId });
    const profile = results?.[0];

    if (!profile) return Response.json({ ok: true, data: { suggestions: [{ field: 'profile', label: 'Complete Profile' }], completeness: 0 } });

    const suggestions = [];
    if (!profile.mission || profile.mission.length < 50) suggestions.push({ field: 'mission', label: 'Mission Statement' });
    if (!profile.focus_areas?.length || profile.focus_areas.length < 3) suggestions.push({ field: 'focus_areas', label: 'Focus Areas' });
    if (!profile.keywords?.length || profile.keywords.length < 5) suggestions.push({ field: 'keywords', label: 'Keywords' });

    return Response.json({ ok: true, data: { profile_id: profile.id, profile_name: profile.name, suggestions, completeness: Math.min(100, (5 - suggestions.length) * 20) } });
  } catch (err) {
    return Response.json({ ok: false, error: err.message });
  }
});