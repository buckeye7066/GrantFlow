import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id, section_type, user_input, tone = 'professional' } = await req.json();
    if (!grant_id || !section_type) return Response.json({ error: 'grant_id and section_type required' }, { status: 400 });

    const grant = await sdk.entities.Grant.get(grant_id);
    if (!grant) return Response.json({ error: 'Grant not found' }, { status: 404 });

    enforceOwnership(user, grant, 'created_by');

    const organization = await sdk.entities.Organization.get(grant.organization_id);
    const existingSections = await sdk.entities.ProposalSection.filter({ grant_id });

    const generatedContent = await sdk.integrations.Core.InvokeLLM({
      prompt: 'Write compelling ' + section_type + ' section in FIRST PERSON. Grant: ' + grant.title + ', Funder: ' + grant.funder + '. Org: ' + organization.name + ', Mission: ' + organization.mission + '. Tone: ' + tone + '. Write 400-600 words, MBA-level, evidence-based.',
    });

    const existing = existingSections.find(s => s.section_name.toLowerCase().includes(section_type.toLowerCase()));
    const section = existing 
      ? await sdk.entities.ProposalSection.update(existing.id, { draft_content: generatedContent, status: 'draft' })
      : await sdk.entities.ProposalSection.create({ grant_id, section_name: section_type.replace(/_/g, ' '), draft_content: generatedContent, section_order: existingSections.length + 1, status: 'draft' });

    return Response.json({ success: true, content: generatedContent, section_id: section.id, word_count: generatedContent.split(/\s+/).length });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});