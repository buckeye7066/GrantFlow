import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { organization_id, university_name } = await req.json();
    if (!organization_id || !university_name) return Response.json({ error: 'Missing organization_id or university_name' }, { status: 400 });

    const organization = await base44.entities.Organization.get(organization_id);
    if (!organization) return Response.json({ error: 'Organization not found' }, { status: 404 });

    const profileSummary = [
      organization.name ? 'Name: ' + organization.name : '',
      organization.gpa ? 'GPA: ' + organization.gpa : '',
      organization.intended_major ? 'Major: ' + organization.intended_major : '',
      organization.state ? 'State: ' + organization.state : ''
    ].filter(Boolean).join('\n');

    const searchResults = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: 'Search ' + university_name + ' for scholarships matching this student: ' + profileSummary + '. Return scholarships with name, amount, eligibility, deadline, url, description, category.',
      add_context_from_internet: true,
      response_json_schema: { type: "object", properties: { scholarships: { type: "array", items: { type: "object", properties: { name: { type: "string" }, amount: { type: "string" }, eligibility: { type: "string" }, deadline: { type: "string" }, url: { type: "string" }, description: { type: "string" }, category: { type: "string" } } } }, financial_aid_office_url: { type: "string" } } }
    });

    let scholarshipsCreated = 0;
    for (const scholarship of (searchResults.scholarships || [])) {
      const existing = await base44.entities.Grant.filter({ organization_id, title: scholarship.name, funder: university_name });
      if (existing.length === 0) {
        await base44.entities.Grant.create({
          organization_id, profile_id: organization_id, organization_created_by: organization.created_by,
          title: scholarship.name || 'Scholarship', funder: university_name, status: 'discovered',
          program_description: scholarship.description + '\n\nEligibility: ' + scholarship.eligibility + '\n\nAmount: ' + scholarship.amount,
          url: scholarship.url, deadline: scholarship.deadline || null, opportunity_type: 'scholarship'
        });
        scholarshipsCreated++;
      }
    }

    return Response.json({ success: true, university: university_name, scholarships_found: scholarshipsCreated });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});