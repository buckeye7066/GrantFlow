import { describe, it, expect } from 'vitest';

/**
 * Compute a stable dedup key for an opportunity record.
 */
function dedupKey(opportunity) {
  const title = String(opportunity.title || '').trim().toLowerCase();
  const funder = String(opportunity.funder || '').trim().toLowerCase();
  const deadline = String(opportunity.deadline || '').trim();
  return [title, funder, deadline].join('|');
}

/**
 * Deduplicate a list of opportunities, keeping the first occurrence.
 */
function dedupe(opportunities) {
  const seen = new Set();
  const result = [];
  for (const opportunity of opportunities) {
    const key = dedupKey(opportunity);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(opportunity);
    }
  }
  return result;
}

describe('dedupRegression', () => {
  it('collapses exact duplicate opportunities', () => {
    const opportunities = [
      {
        id: '1',
        title: 'Community Arts Grant',
        funder: 'Ohio Arts Council',
        deadline: '2025-06-01',
      },
      {
        id: '2',
        title: 'Community Arts Grant',
        funder: 'Ohio Arts Council',
        deadline: '2025-06-01',
      },
    ];
    const result = dedupe(opportunities);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('treats case and whitespace differences as duplicates', () => {
    const opportunities = [
      {
        id: '1',
        title: 'Community Arts Grant',
        funder: 'Ohio Arts Council',
        deadline: '2025-06-01',
      },
      {
        id: '2',
        title: '  community arts grant  ',
        funder: 'OHIO ARTS COUNCIL',
        deadline: '2025-06-01',
      },
    ];
    expect(dedupe(opportunities)).toHaveLength(1);
  });

  it('keeps distinct opportunities separate', () => {
    const opportunities = [
      {
        id: '1',
        title: 'Community Arts Grant',
        funder: 'Ohio Arts Council',
        deadline: '2025-06-01',
      },
      {
        id: '2',
        title: 'Science Education Grant',
        funder: 'National Science Foundation',
        deadline: '2025-09-15',
      },
    ];
    const result = dedupe(opportunities);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.id)).toEqual(['1', '2']);
  });

  it('handles an empty input list without error', () => {
    expect(dedupe([])).toEqual([]);
  });
});
