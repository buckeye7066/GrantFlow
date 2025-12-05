import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";
import { acquireLock, releaseLock } from "./_shared/atomicLock.js";

const DEFAULT_JOBS = [
  "runSmartAutomation",
  "runBackgroundAutoAdvance",
  "autoMonitor",
];

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobs = Array.isArray(body.jobs) && body.jobs.length > 0
    ? body.jobs
    : DEFAULT_JOBS;
  const payloads = typeof body.payloads === "object" && body.payloads
    ? body.payloads
    : {};
  const requireLock = body.require_lock !== false;
  const requestId = `batch_${crypto.randomUUID().slice(0, 8)}`;

  if (jobs.some((job) => typeof job !== "string")) {
    return Response.json({ error: "jobs must be an array of strings" }, {
      status: 400,
    });
  }

  let lockInfo = { acquired: false, reason: "lock disabled" };
  if (requireLock) {
    lockInfo = await acquireLock(sdk, requestId);
    if (!lockInfo.acquired) {
      return Response.json({
        error: `Automation lock unavailable: ${lockInfo.reason}`,
      }, { status: 409 });
    }
  }

  const results = [];
  try {
    for (const job of jobs) {
      const jobPayload = payloads[job] ?? {};
      try {
        const response = await base44.functions.invoke(job, jobPayload);
        results.push({
          function: job,
          ok: response?.error ? false : true,
          response,
        });
      } catch (error) {
        results.push({
          function: job,
          ok: false,
          error: error.message,
        });
      }
    }
  } finally {
    if (lockInfo.acquired) {
      await releaseLock(sdk, requestId);
    }
  }

  return {
    lock: lockInfo,
    jobs: results,
  };
}, { name: "runBatchAutomation" });
