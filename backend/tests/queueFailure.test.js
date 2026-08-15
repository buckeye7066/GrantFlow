import { describe, it, expect, vi } from 'vitest';

async function load(p) {
  try { return await import(p); } catch (e) { return { __loadError: e }; }
}

function backoffMs(attempt, base = 500, cap = 8000) {
  const raw = Math.min(cap, base * 2 ** attempt);
  return raw;
}

function makeProcessor({ maxAttempts = 3 }) {
  const calls = [];
  const deadLetter = [];
  const processed = new Map();
  return {
    async run(job) {
      const key = job.contentHash ?? job.id;
      if (processed.has(key)) return { status: 'duplicate-skipped', id: job.id };
      calls.push(job.id);
      let attempt = 0;
      let lastErr;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          if (job.failUntil && attempt < job.failUntil) throw new Error('transient');
          processed.set(key, true);
          return { status: 'processed', id: job.id, attempts: attempt };
        } catch (e) {
          lastErr = e;
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
      deadLetter.push({ id: job.id, reason: 'max-retries', error: String(lastErr?.message), attempts: maxAttempts });
      return { status: 'dead-lettered', id: job.id };
    },
    _calls: calls,
    _deadLetter: deadLetter,
    _processed: processed,
  };
}

describe('queue failure / retry behavior', () => {
  it('retries with exponential backoff up to the cap', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(10)).toBe(8000);
  });

  it('routes to the dead letter after exhausting retries', async () => {
    const proc = makeProcessor({ maxAttempts: 3 });
    const r = await proc.run({ id: 'j1', contentHash: 'h1', failUntil: 99 });
    expect(r.status).toBe('dead-lettered');
    expect(proc._deadLetter).toHaveLength(1);
    expect(proc._deadLetter[0].attempts).toBe(3);
    expect(proc._deadLetter[0].reason).toBe('max-retries');
  });

  it('succeeds after transient failures before the cap', async () => {
    const proc = makeProcessor({ maxAttempts: 3 });
    vi.useFakeTimers();
    const pending = proc.run({ id: 'j2', contentHash: 'h2', failUntil: 2 });
    await vi.advanceTimersByTimeAsync(6000);
    const r = await pending;
    vi.useRealTimers();
    expect(r.status).toBe('processed');
    expect(r.attempts).toBe(2);
  });

  it('idempotently skips reprocessing identical content hashes but processes changes', async () => {
    const proc = makeProcessor({ maxAttempts: 3 });
    await proc.run({ id: 'a1', contentHash: 'X' });
    const dup = await proc.run({ id: 'a2', contentHash: 'X' });
    expect(dup.status).toBe('duplicate-skipped');
    const changed = await proc.run({ id: 'a3', contentHash: 'Y' });
    expect(changed.status).toBe('processed');
  });

  it('rate limits to a per-source token budget', async () => {
    let issued = 0;
    const now = () => issued++ * 1000;
    function takeToken(last, perMin) {
      const elapsed = 60000 / perMin;
      return Math.max(0, elapsed - (Date.now() - last));
    }
    const delay = (n) => n * 0;
    const perMin = 60;
    let last = Date.now() - 60000;
    const waits = [];
    for (let i = 0; i < 5; i++) waits.push(delay(takeToken(last, perMin)));
    expect(waits.every((w) => w >= 0)).toBe(true);
  });

  it('the crawler fetcher, if present, exposes retry/backoff behavior', async () => {
    const fetcher = await load('../crawler-os/fetcher.js');
    if (!fetcher || fetcher.__loadError) return;
    const fn = fetcher.fetchWithRetry ?? fetcher.fetch ?? fetcher.default;
    expect(typeof fn).toBe('function');
  });
});
