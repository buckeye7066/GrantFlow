import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";

async function logActivity(sdk, grantId, userId, message, metadata = {}) {
  try {
    await sdk.entities.Activity.create({
      entity_type: "Grant",
      entity_id: grantId,
      created_by: userId,
      message,
      metadata,
      type: "submission",
    });
  } catch (error) {
    console.warn("Failed to log submission activity:", error.message);
  }
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const grantId = body.grant_id ?? body.id;
  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  const grant = await sdk.entities.Grant.get(grantId).catch(() => null);
  if (!grant) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }

  enforceOwnership(user, grant, "created_by");

  const submissionPayload = body.payload ?? body.submission ?? {};
  const now = new Date().toISOString();

  const submission = await sdk.entities.GrantSubmission.create({
    grant_id: grantId,
    submitted_by: user.id,
    payload: submissionPayload,
    status: "submitted",
    submitted_at: now,
  }).catch(async (error) => {
    if (error?.message?.includes("unique")) {
      return await sdk.entities.GrantSubmission.filter({
        grant_id: grantId,
      }).then((rows) => rows?.[0] ?? null);
    }
    throw error;
  });

  const updatedGrant = await sdk.entities.Grant.update(grantId, {
    status: "submitted",
    submitted_at: now,
    submission_strategy: grant.submission_strategy ??
      submissionPayload.strategy ?? null,
  });

  await logActivity(
    sdk,
    grantId,
    user.id,
    `Grant "${grant.title}" submitted by ${user.email ?? user.id}`,
    { submission_id: submission?.id ?? null },
  );

  return {
    submission,
    grant: updatedGrant,
  };
}, { name: "submitGrant" });
