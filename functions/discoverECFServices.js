import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { profile_id, organization_id } = body;
    const profileId = profile_id || organization_id;
    if (!profileId) return Response.json({ success: false, error: 'profile_id required' }, { status: 400 });

    const profile = await base44.entities.Organization.get(profileId);
    if (!profile) return Response.json({ success: false, error: 'Profile not found' }, { status: 404 });

    if (!profile.medicaid_enrolled || profile.medicaid_waiver_program !== 'ecf_choices') {
      return Response.json({ success: false, error: 'Not ECF CHOICES participant' }, { status: 400 });
    }

    const sdk = base44.asServiceRole;
    const location = { city: profile.city, state: profile.state };
    const discoveredServices = [];

    // Gym memberships
    const gymResponse = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Find gyms/YMCAs in ' + location.city + ', ' + location.state + ' accepting TennCare/Medicaid.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { facilities: { type: "array", items: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, website: { type: "string" } } } } } }
    });
    
    for (const facility of (gymResponse?.facilities || [])) {
      discoveredServices.push({ title: facility.name + ' - Fitness', sponsor: facility.name, descriptionMd: 'Fitness facility accepting TennCare', fundingType: 'benefit', categories: ['fitness'], regions: [location.city], url: facility.website || '', source: 'ecf_choices_discovery', source_id: 'gym_' + facility.name.toLowerCase().replace(/\s+/g, '_'), rolling: true });
    }

    const savedServices = [];
    for (const service of discoveredServices) {
      try {
        const existing = await sdk.entities.FundingOpportunity.filter({ source: service.source, source_id: service.source_id });
        const saved = existing.length === 0 ? await sdk.entities.FundingOpportunity.create(service) : await sdk.entities.FundingOpportunity.update(existing[0].id, service);
        savedServices.push(saved);
      } catch (e) {}
    }

    return Response.json({ success: true, discovered_count: discoveredServices.length, saved_count: savedServices.length, services: savedServices });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});