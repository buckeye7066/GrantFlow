import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import {
  loadProfileContext,
  matchGrants,
  recordMatchAccess,
} from "./_shared/matchingEngine.js";

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const limit = Number(body.limit) || 10;

  if (!profileId && !organizationId) {
    return Response.json({
      error: "profile_id or organization_id is required",
    }, { status: 400 });
  }

  const context = await loadProfileContext(
    sdk,
    user,
    { profileId, organizationId },
  );

  await recordMatchAccess(sdk, context, user, "matchProfileToGrants");

  const matches = await matchGrants(base44, sdk, context, { limit });

  return {
    profile_id: context.profile.id,
    organization_id: context.organization?.id ?? null,
    strategy: {
      geography: context.strategy.geography,
      keywords: Array.from(context.strategy.keywords ?? []),
      assistancePrograms: context.strategy.assistancePrograms,
    },
    funding_axes: context.axes,
    matches,
  };
}, { name: "matchProfileToGrants" });
