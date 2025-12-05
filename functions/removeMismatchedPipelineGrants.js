import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import { acquireLock, releaseLock } from "./_shared/atomicLock.js";

const BATCH_SIZE = 200;
const DEFAULT_STATUSES = ["pending", "running"];

async function fetchQueueBatch(sdk, filters, offset) {
  return await sdk.entities.ProcessingQueue.filter(
    filters,
    {
      limit: BATCH_SIZE,
      offset,
      order: [{ column: "created_at", ascending: true }],
    },
  ).catch(() => []);
}

async function deleteQueueEntry(sdk, entryId) {
  try {
    await sdk.entities.ProcessingQueue.delete(entryId);
    return { deleted: true };
  } catch (error) {
    try {
      await sdk.entities.ProcessingQueue.update(entryId, {
        status: "cancelled",
        locked_by: null,
        finished_at: new Date().toISOString(),
      });
      return { deleted: false, statusUpdated: true, error: error.message };
    } catch (innerError) {
      return {
        deleted: false,
        statusUpdated: false,
        error: innerError.message,
      };
    }
  }
}

async function archiveGrant(sdk, grantId, status) {
  try {
    await sdk.entities.Grant.update(grantId, {
      status,
      removed_at: new Date().toISOString(),
      removed_reason: "Removed due to profile mismatch",
    });
    return { updated: true };
  } catch (error) {
    return { updated: false, error: error.message };
  }
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const dryRun = body.dry_run === true;
  const removeGrants = body.remove_grants === true;
  const newGrantStatus = body.grant_status ?? "archived";
  const statuses = Array.isArray(body.queue_status) && body.queue_status.length
    ? body.queue_status
    : DEFAULT_STATUSES;

  if (organizationId && !profileId) {
    return Response.json({
      error: "profile_id must be provided when filtering by organization_id",
    }, { status: 400 });
  }

  const requestId = `scrub_${crypto.randomUUID().slice(0, 8)}`;
  const lockInfo = await acquireLock(sdk, requestId);
  if (!lockInfo.acquired) {
    return Response.json({
      error: `Unable to acquire automation lock: ${lockInfo.reason}`,
    }, { status: 409 });
  }

  const filters = {};
  if (profileId) filters.profile_id = profileId;
  if (organizationId) filters.organization_id = organizationId;
  if (body.queue_status !== "all") {
    filters.status = { in: statuses };
  }

  const result = {
    lock: lockInfo,
    scanned: 0,
    mismatched: [],
  };

  try {
    let offset = 0;
    while (true) {
      const entries = await fetchQueueBatch(sdk, filters, offset);
      if (!entries.length) break;

      for (const entry of entries) {
        result.scanned += 1;
        const grant = await sdk.entities.Grant.get(entry.grant_id).catch(() =>
          null
        );

        const entryProfileId = entry.profile_id ?? null;
        const grantProfileId = grant?.profile_id ?? null;
        const mismatch = !grant ||
          (entryProfileId && grantProfileId &&
            entryProfileId !== grantProfileId);

        if (!mismatch) continue;

        const record = {
          queue_id: entry.id,
          grant_id: entry.grant_id,
          entry_profile_id,
          grant_profile_id: grantProfileId,
          reason: grant ? "profile mismatch" : "grant missing",
          actions: {},
        };

        if (!dryRun) {
          record.actions.queue = await deleteQueueEntry(sdk, entry.id);
          if (removeGrants && grant) {
            record.actions.grant = await archiveGrant(
              sdk,
              grant.id,
              newGrantStatus,
            );
          }
        }

        result.mismatched.push(record);
      }

      if (entries.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }
  } finally {
    await releaseLock(sdk, requestId);
  }

  return result;
}, { name: "removeMismatchedPipelineGrants" });
