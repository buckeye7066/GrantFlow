import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import {
  loadProfileContext,
  matchGrants,
  recordMatchAccess,
} from "./_shared/matchingEngine.js";

function buildNextSteps(matches) {
  if (!matches?.length) {
    return [
      "Refresh profile qualifiers and run the crawler smoke test to discover new opportunities.",
      "Expand geographic coverage or assistance programs to widen the search.",
      "Launch crawlLocalSources with test_mode=false to pull latest local grants.",
    ];
  }

  const highQuality = matches.filter((match) => match.match_score >= 70);
  if (highQuality.length >= 3) {
    return [
      "Move recommended grants into the active pipeline and assign follow-up tasks.",
      "Use generateProgressReport or prepareGrantSubmission to get submission-ready materials.",
      "Schedule outreach reminders via sendReportReminders or related automation.",
    ];
  }

  return [
    "Review rationale for lower-scoring matches and adjust profile keywords or qualifiers.",
    "Trigger crawlLocalSources and crawlGrantsGov with the latest strategy keywords.",
    "Consider running matchFunderToProfile to validate funder compatibility.",
  ];
}

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const limit = Number(body.limit) || 15;

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

  await recordMatchAccess(sdk, context, user, "comprehensiveMatch");

  const matches = await matchGrants(base44, sdk, context, { limit });
  const nextSteps = buildNextSteps(matches, context);

  return {
    profile_id: context.profile.id,
    organization_id: context.organization?.id ?? null,
    summary: context.summary,
    strategy: {
      geography: context.strategy.geography,
      keywords: Array.from(context.strategy.keywords ?? []),
      assistancePrograms: context.strategy.assistancePrograms,
    },
    funding_axes: context.axes,
    matches,
    next_steps: nextSteps,
  };
}, { name: "comprehensiveMatch" });
