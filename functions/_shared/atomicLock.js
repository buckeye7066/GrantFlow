// ============================================================================
// ATOMIC LOCK SYSTEM (FINAL, RACE-SAFE, JSON-SAFE, BASE44-SAFE)
// Production-ready with environment-aware logging for Base44 integration
// ============================================================================

import { createLogger } from './logger.js';

const logger = createLogger('AtomicLock');
const DEFAULT_LOCK_ID = "global_automation";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

async function getLockRow(sdk) {
  let rows = await sdk.entities.AutomationLock.filter({ lock_id: DEFAULT_LOCK_ID });

  if (rows.length === 1) return rows[0];

  if (rows.length > 1) {
    const sorted = rows.sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return aTime - bTime;
    });
    const keep = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      await sdk.entities.AutomationLock.delete(sorted[i].id);
    }

    return keep;
  }

  try {
    return await sdk.entities.AutomationLock.create({
      lock_id: DEFAULT_LOCK_ID,
      locked: false,
      locked_by: null,
      locked_at: null
    });
  } catch (err) {
    rows = await sdk.entities.AutomationLock.filter({ lock_id: DEFAULT_LOCK_ID });
    return rows[0];
  }
}

export async function acquireLock(sdk, requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const lock = await getLockRow(sdk);
    const now = Date.now();

    if (lock.locked) {
      const lockedAt = lock.locked_at ? new Date(lock.locked_at).getTime() : 0;
      const elapsed = now - lockedAt;

      if (elapsed > timeoutMs) {
        // Base44 integration: Debug log for lock operations
        logger.debug(
          \`Force-releasing stale lock (\${elapsed}ms old, held by \${lock.locked_by})\`
        );

        await sdk.entities.AutomationLock.update(lock.id, {
          locked: false,
          locked_by: null,
          locked_at: null
        });

        await sdk.entities.AutomationLock.update(lock.id, {
          locked: true,
          locked_by: requestId,
          locked_at: new Date().toISOString()
        });

        const verify = await sdk.entities.AutomationLock.get(lock.id);
        if (verify.locked_by !== requestId) {
          return { acquired: false, reason: "Race during forced acquire" };
        }

        return { acquired: true, forced: true };
      }

      return { acquired: false, reason: \`Lock held by \${lock.locked_by}\` };
    }

    await sdk.entities.AutomationLock.update(lock.id, {
      locked: true,
      locked_by: requestId,
      locked_at: new Date().toISOString()
    });

    const verify = await sdk.entities.AutomationLock.get(lock.id);
    if (verify.locked_by !== requestId) {
      return { acquired: false, reason: \`Race: lock taken by \${verify.locked_by}\` };
    }

    return { acquired: true };

  } catch (err) {
    return { acquired: false, reason: String(err?.message || err) };
  }
}

export async function releaseLock(sdk, requestId) {
  try {
    const lock = await getLockRow(sdk);

    if (requestId && lock.locked_by && lock.locked_by !== requestId) {
      // Warning: potential lock conflict - always log
      logger.warn(
        \`Release requested by \${requestId} but held by \${lock.locked_by}\`
      );
    }

    try {
      await sdk.entities.AutomationLock.update(lock.id, {
        locked: false,
        locked_by: null,
        locked_at: null
      });
    } catch (innerErr) {
      await sdk.entities.AutomationLock.update(lock.id, {
        locked: false,
        locked_by: null,
        locked_at: null
      });
    }

    return { success: true };

  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
}

export async function checkLockStatus(sdk) {
  try {
    const lock = await getLockRow(sdk);
    return {
      locked: !!lock.locked,
      locked_by: lock.locked_by,
      locked_at: lock.locked_at
    };
  } catch (err) {
    return { locked: false, error: String(err?.message || err) };
  }
}

export function forceReleaseLock(sdk) {
  return releaseLock(sdk, null);
}