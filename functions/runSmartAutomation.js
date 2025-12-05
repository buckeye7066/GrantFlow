import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import { acquireLock, releaseLock } from "./_shared/atomicLock.js";

const BATCH_LIMIT = 5;

async function loadPendingQueue(sdk) {
  const rows = await sdk.entities.ProcessingQueue.filter(
    { status: "pending" },
    {
      limit: BATCH_LIMIT,
      offset: 0,
      order: [{ column: "created_at", ascending: true }],
    },
  ).catch(() => []);

  return Array.isArray(rows) ? rows : [];
}

async function markRunning(sdk, jobId, requestId) {
  try {
    await sdk.entities.ProcessingQueue.update(jobId, {
      status: "running",
      started_at: new Date().toISOString(),
      locked_by: requestId,
    });
    return true;
  } catch (_err) {
    return false;
  }
}

async function finalizeJob(sdk, jobId, status, data = {}) {
  const payload = {
    status,
    locked_by: null,
    finished_at: new Date().toISOString(),
  };

  if (status === "done") {
    payload.result = data.result ?? null;
  } else if (status === "error") {
    payload.error_message = data.error ?? "Unknown error";
    payload.attempts = (data.attempts ?? 0) + 1;
    payload.status = payload.attempts >= 3 ? "failed" : "pending";
  }

  await sdk.entities.ProcessingQueue.update(jobId, payload);
}

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const requestId = `smart_${crypto.randomUUID().slice(0, 8)}`;
  const lockInfo = await acquireLock(sdk, requestId);
  if (!lockInfo.acquired) {
    return Response.json({
      error: `Unable to acquire automation lock: ${lockInfo.reason}`,
    }, { status: 409 });
  }

  const jobs = await loadPendingQueue(sdk);
  const results = [];

  try {
    for (const job of jobs) {
      const { id, profile_id, grant_id } = job;
      const running = await markRunning(sdk, id, requestId);
      if (!running) {
        results.push({ id, ok: false, error: "Failed to mark job as running" });
        continue;
      }

      try {
        const response = await base44.functions.invoke("processSingleGrant", {
          profile_id,
          grant_id,
        });

        await finalizeJob(sdk, id, "done", { result: response });
        results.push({ id, ok: true, response });
      } catch (error) {
        await finalizeJob(sdk, id, "error", {
          error: error.message,
          attempts: job.attempts ?? 0,
        });
        results.push({ id, ok: false, error: error.message });
      }
    }
  } finally {
    await releaseLock(sdk, requestId);
  }

  return {
    processed: results.length,
    jobs: results,
  };
}, { name: "runSmartAutomation" });
