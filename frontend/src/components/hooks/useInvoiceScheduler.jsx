import { useEffect, useRef } from 'react';

/**
 * Compute "now" in America/New_York and return y/m/d hour/min/sec in 24h.
 */
function nowInNY() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const hh = Number(parts.hour);
  const mm = Number(parts.minute);
  const ss = Number(parts.second);
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  // NOTE: This Date object is UTC-based but represents NY wall clock; we only use components below.
  return { y, m, d, hh, mm, ss, weekday: new Date(date).getUTCDay() };
}

/**
 * Return the "slot id" string for the current target window (e.g., YYYY-Www for Fridays at/after hour),
 * used to avoid multiple runs per schedule.
 */
function computeWeeklySlotId(targetWeekday, targetHour) {
  const ny = nowInNY();
  // Determine if we've reached the run window for this week:
  const reachedDay = ny.weekday > targetWeekday || (ny.weekday === targetWeekday && ny.hh >= targetHour);
  // Compute ISO week-like token: year-week + phase (0: before day/hour, 1: after)
  // This keeps dedup simple: we only allow one run when "after" flips true per week.
  // For uniqueness across weeks, include year + "week number".
  const date = new Date(); // wall clock not reliable for NY week; approximate with local week index by day distance
  // A simple stable "week id": year + '-W' + floor(dayOfYear/7)
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / 86400000);
  const weekId = `${date.getFullYear()}-W${Math.floor(dayOfYear / 7)}`;
  const phase = reachedDay ? '1' : '0';
  return `${weekId}-D${targetWeekday}-H${targetHour}-P${phase}`;
}

/**
 * Acquire a localStorage-based lock for cross-tab mutual exclusion.
 */
function tryAcquireLock(key, ttlMs) {
  try {
    const now = Date.now();
    const raw = localStorage.getItem(key);
    if (raw) {
      const { owner, expiresAt } = JSON.parse(raw);
      if (expiresAt && expiresAt > now) {
        // Active lock exists
        return null;
      }
    }
    const me = `${Math.random().toString(36).slice(2)}:${now}`;
    const lockObj = { owner: me, createdAt: now, expiresAt: now + ttlMs };
    localStorage.setItem(key, JSON.stringify(lockObj));
    // Re-read to confirm ownership (avoid race)
    const confirm = localStorage.getItem(key);
    if (!confirm) return null;
    const parsed = JSON.parse(confirm);
    if (parsed.owner === me) {
      return me;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Release lock if owned.
 */
function releaseLock(key, owner) {
  if (!owner) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.owner === owner) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/**
 * useInvoiceScheduler
 * - Default behavior matches legacy: weekly, Friday, 16:00 NY time, console log only.
 * - You can pass `onDue` to trigger actual generation.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled=true] Enable/disable the scheduler
 * @param {'weekly'} [opts.frequency='weekly'] Frequency control
 * @param {0|1|2|3|4|5|6} [opts.weekday=5] Day of week to run (0=Sun ... 6=Sat)
 * @param {number} [opts.hour=16] 24h hour in America/New_York to run at
 * @param {() => Promise<void> | void} [opts.onDue] Callback invoked once when the run becomes due
 * @param {number} [opts.checkIntervalMs=300000] Poll/check cadence in ms (default 5 minutes)
 * @param {string} [opts.storageKeyBase='invoiceScheduler:v1'] LocalStorage namespace key
 * @param {number} [opts.lockTtlMs=300000] Lock TTL to avoid deadlocks (default 5 minutes)
 */
export function useInvoiceScheduler(opts) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    // SSR/No storage guard
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;

    const {
      enabled = true,
      frequency = 'weekly',
      weekday = 5, // Friday
      hour = 16, // 16:00
      onDue,
      checkIntervalMs = 5 * 60 * 1000, // 5 min
      storageKeyBase = 'invoiceScheduler:v1',
      lockTtlMs = 5 * 60 * 1000, // 5 min
    } = optsRef.current || {};

    if (!enabled) return;

    const LAST_RUN_KEY = `${storageKeyBase}:lastRunSlot`;
    const LOCK_KEY = `${storageKeyBase}:lock`;

    let intervalId = null;
    let visibilityHandler = null;
    let lockOwner = null;

    const check = async () => {
      try {
        if (frequency !== 'weekly') return; // future extension point

        // Compute if "due"
        const slotId = computeWeeklySlotId(weekday, hour);
        const lastRun = localStorage.getItem(LAST_RUN_KEY);

        // We only run once when the "phase flips" to after-target for this week
        const isAfterTarget = slotId.endsWith('-P1');
        const alreadyRanThisSlot = lastRun === slotId;

        if (!isAfterTarget || alreadyRanThisSlot) return;

        // Attempt to acquire a cross-tab lock
        lockOwner = tryAcquireLock(LOCK_KEY, lockTtlMs);
        if (!lockOwner) {
          // Another tab will handle it
          return;
        }

        // Execute the job
        const currentOnDue = optsRef.current?.onDue;
        if (currentOnDue) {
          try {
            await currentOnDue();
          } catch (jobErr) {
            console.error('[useInvoiceScheduler] onDue() failed:', jobErr);
          }
        } else {
          // Legacy behavior: log only
          console.log("[useInvoiceScheduler] It's time to generate draft invoices (NY time window reached).");
        }

        // Mark as done for this slot
        localStorage.setItem(LAST_RUN_KEY, slotId);
      } catch (err) {
        console.warn('[useInvoiceScheduler] Check failed:', err?.message || err);
      } finally {
        // Release lock if we acquired it
        releaseLock(LOCK_KEY, lockOwner);
        lockOwner = null;
      }
    };

    // Run once on mount
    check();

    // Check when tab becomes visible again
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        check();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    // Periodic check
    intervalId = window.setInterval(check, checkIntervalMs);

    // Cleanup
    return () => {
      if (intervalId) window.clearInterval(intervalId);
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      // Best-effort lock release if still owned
      releaseLock(LOCK_KEY, lockOwner);
    };
  }, []);
}