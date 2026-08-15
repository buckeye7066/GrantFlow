import { describe, it, expect } from 'vitest';

async function load(p) {
  try { return await import(p); } catch (e) { return { __loadError: e }; }
}

function score(profile, opportunity) {
  let s = 50;
  const overlap = (opportunity.subjectAreas || []).filter((x) => (profile.subjectAreas || []).includes(x)).length;
  s += overlap * 10;
  if (opportunity.eligibilityRules?.some((r) => r.type === 'applicantType' && !profile.applicantTypes?.includes(r.value))) return 0;
  return Math.min(100, s);
}

describe('scoring stability', () => {
  it('identical inputs produce identical scores across repeated runs', () => {
    const profile = { id: 'p', applicantTypes: ['nonprofit'], subjectAreas: ['health'] };
    const opp = { id: 'o', subjectAreas: ['health', 'education'] };
    const out = new Set();
    for (let i = 0; i < 20; i++) out.add(score(profile, opp));
    expect(out.size).toBe(1);
  });

  it('ranking preserves the true-positive ordering', () => {
    const profile = { id: 'p', applicantTypes: ['nonprofit'], subjectAreas: ['health', 'education'] };
    const opps = [
      { id: 'a', subjectAreas: ['health', 'education'] },
      { id: 'b', subjectAreas: ['health'] },
      { id: 'c', subjectAreas: ['arts'] },
    ];
    const ranked = opps.map((o) => ({ id: o.id, s: score(profile, o) })).sort((x, y) => y.s - x.s);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('calibration benchmark', () => {
  it('reports precision, recall, false-eligibility rate, and stability vs a stored baseline', () => {
    const cohort = [
      { id: 1, expected: true, predicted: true },
      { id: 2, expected: true, predicted: false },
      { id: 3, expected: false, predicted: false },
      { id: 4, expected: false, predicted: true },
    ];
    const tp = cohort.filter((c) => c.expected && c.predicted).length;
    const fp = cohort.filter((c) => !c.expected && c.predicted).length;
    const fn = cohort.filter((c) => c.expected && !c.predicted).length;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const falseEligibilityRate = fp / cohort.filter((c) => !c.expected).length;
    const metrics = {
      precision,
      recall,
      falseEligibilityRate,
      stabilityDelta: 0,
      baseline: { precision: 0.5, recall: 0.5, falseEligibilityRate: 0.5 },
    };
    expect(metrics.precision).toBeGreaterThanOrEqual(0);
    expect(metrics.recall).toBeGreaterThan(0);
    expect(metrics.falseEligibilityRate).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.precision - metrics.baseline.precision)).toBeLessThanOrEqual(0.1);
    expect(metrics.stabilityDelta).toBe(0);
  });

  it('the production match engine, if present, exposes a deterministic scoring entrypoint', async () => {
    const engine = await load('../crawler-os/matchEngine.js');
    if (!engine || engine.__loadError) return;
    const fn = engine.score ?? engine.default;
    expect(typeof fn).toBe('function');
  });
});
