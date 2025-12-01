import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { getSafeSDK, enforceOwnership } from './_shared/security.js';
import { resolveGrantId } from './_utils/resolveEntityId.js';

Deno.serve(async (req) => {
  try {
    const { sdk, user } = await getSafeSDK(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { grant_id: rawGrantId, submission_method, confirmation_number } = await req.json();
    if (!rawGrantId) return Response.json({ error: 'grant_id required' }, { status: 400 });

    const grant_id = await resolveGrantId(sdk, rawGrantId);
    const grant = await sdk.entities.Grant.get(grant_id);
    if (!grant) return Response.json({ error: 'Grant not found' }, { status: 404 });

    enforceOwnership(user, grant, 'created_by');

    const updatedGrant = await sdk.entities.Grant.update(grant_id, {
      status: 'submitted', submission_date: new Date().toISOString(), submission_method: submission_method || 'online',
      confirmation_number: confirmation_number || '', submitted_by: user.email
    });

    await sdk.entities.Milestone.create({
      grant_id, title: 'Grant Submitted', description: 'Submitted via ' + (submission_method || 'online'),
      due_date: new Date().toISOString().split('T')[0], milestone_type: 'submission', completed: true, completed_date: new Date().toISOString().split('T')[0]
    });

    await sdk.integrations.Core.SendEmail({
      to: user.email, subject: '✅ Grant Submission Confirmed: ' + grant.title,
      body: 'Your grant application has been submitted successfully! Grant: ' + grant.title + ', Funder: ' + grant.funder
    });

    return Response.json({ success: true, grant: updatedGrant, message: 'Grant submitted successfully' });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});