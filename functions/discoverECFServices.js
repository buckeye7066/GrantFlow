import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Discover ECF Services - Specialized ECF CHOICES service discovery
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json();
    const { profile_id, organization_id } = body;
    const profileId = profile_id || organization_id;

    if (!profileId) return Response.json({ success: false, error: 'profile_id required' }, { status: 400 });

    const profile = await base44.entities.Organization.get(profileId);
    if (!profile) return Response.json({ success: false, error: 'Profile not found' }, { status: 404 });
    if (!profile.medicaid_enrolled || profile.medicaid_waiver_program !== 'ecf_choices') {
      return Response.json({ success: false, error: 'Not ECF CHOICES participant' }, { status: 400 });
    }

    const location = `${profile.city}, ${profile.state}`;
    const discovered = [];

    const categories = ['fitness/gyms', 'food assistance', 'transportation', 'medical equipment'];
    for (const category of categories) {
      const prompt = `Find ${category} programs in ${location} for Medicaid/ECF CHOICES participants. Return name, type, address, phone, website, services.`;
      try {
        const result = await sdk.integrations.Core.InvokeLLM({
          prompt, add_context_from_internet: true,
          response_json_schema: { type: "object", properties: { programs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, services: { type: "array", items: { type: "string" } } } } } } }
        });
        for (const program of (result.programs || [])) {
          discovered.push({ title: `${program.name} - ${category}`, sponsor: program.name, fundingType: 'benefit', categories: [category], regions: [location] });
        }
      } catch (e) {}
    }

    return Response.json({ success: true, discovered_count: discovered.length, services: discovered });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});