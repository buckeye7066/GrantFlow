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
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const limit = Number(body.limit) || 15;

  if (!organizationId) {
    return Response.json({
      error: "organization_id is required",
    }, { status: 400 });
  }

  const context = await loadProfileContext(
    sdk,
    user,
    { organizationId },
  );

  await recordMatchAccess(sdk, context, user, "matchGrantsForOrganization");

  const matches = await matchGrants(base44, sdk, context, { limit });

  return {
    organization_id: context.organization?.id ?? null,
    profile_id: context.profile.id,
    strategy: {
      geography: context.strategy.geography,
      keywords: Array.from(context.strategy.keywords ?? []),
      assistancePrograms: context.strategy.assistancePrograms,
    },
    funding_axes: context.axes,
    matches,
  };
}, { name: "matchGrantsForOrganization" });
