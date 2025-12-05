import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import { acquireLock, releaseLock } from "./_shared/atomicLock.js";

const MAX_GRANTS = 10;

function shouldAdvance(grant) {
  const score = Number(grant.match_score ?? grant.ai_match_score ?? 0);
  const ready = (grant.ai_status ?? "").toLowerCase() === "ready";
  const narrativeReady = Boolean(
    grant.narrative && grant.narrative.length > 100,
  );
  return score >= 70 && ready && narrativeReady;
}

async function loadCandidateGrants(sdk) {
  const grants = await sdk.entities.Grant.filter(
    { status: "interested" },
    {
      limit: MAX_GRANTS,
      offset: 0,
      order: [{ column: "updated_at", ascending: true }],
    },
  ).catch(() => []);

  return Array.isArray(grants) ? grants : [];
}

async function markAdvanced(sdk, grant, userId) {
  const updated = await sdk.entities.Grant.update(grant.id, {
    status: "ready_for_submission",
    advanced_at: new Date().toISOString(),
    advanced_by: userId,
  });

  try {
    await sdk.entities.Activity.create({
      entity_type: "Grant",
      entity_id: grant.id,
      type: "auto_advance",
      message: `Grant "${grant.title}" auto-advanced to ready_for_submission`,
      metadata: { match_score: grant.match_score ?? null },
    });
  } catch (_err) {
    // Non-fatal
  }

  return updated;
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestId = `advance_${crypto.randomUUID().slice(0, 8)}`;
  const lockInfo = await acquireLock(sdk, requestId);
  if (!lockInfo.acquired) {
    return Response.json({
      error: `Unable to acquire automation lock: ${lockInfo.reason}`,
    }, { status: 409 });
  }

  const candidates = await loadCandidateGrants(sdk);
  const advanced = [];
  const skipped = [];

  try {
    for (const grant of candidates) {
      if (!shouldAdvance(grant)) {
        skipped.push({ id: grant.id, reason: "Not ready" });
        continue;
      }

      try {
        const updated = await markAdvanced(sdk, grant, user.id);
        advanced.push({ id: grant.id, status: updated.status });
      } catch (error) {
        skipped.push({ id: grant.id, reason: error.message });
      }
    }
  } finally {
    await releaseLock(sdk, requestId);
  }

  return {
    advanced,
    skipped,
  };
}, { name: "runBackgroundAutoAdvance" });
