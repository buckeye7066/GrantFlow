import { describe, it, expect } from 'vitest';
import { canonicalOpportunityKey, titleIdentityKey } from '../crawler-os/contract.js';

/**
 * Regression coverage for the ONE catalog identity rule.
 *
 * The canonical key lives in backend/crawler-os/contract.js
 * (canonicalOpportunityKey: external_id → token-sorted title+sponsor → URL)
 * and is consulted by both crawler-os/storage.upsertOpportunity and
 * services/opportunityInserter.upsertFundingOpportunity. Do NOT introduce a
 * second identity rule here — these tests pin the canonical one.
 */
function dedupe(opportunities) {
  const seen = new Set();
  const result = [];
  for (const opportunity of opportunities) {
    const key = canonicalOpportunityKey(opportunity);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(opportunity);
    }
  }
  return result;
}

describe('dedupRegression (canonical identity)', () => {
  it('collapses exact duplicate opportunities', () => {
    const opportunities = [
      { id: '1', title: 'Community Arts Grant', sponsor: 'Ohio Arts Council' },
      { id: '2', title: 'Community Arts Grant', sponsor: 'Ohio Arts Council' },
    ];
    const result = dedupe(opportunities);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('treats case and whitespace differences as duplicates', () => {
    const opportunities = [
      { id: '1', title: 'Community Arts Grant', sponsor: 'Ohio Arts Council' },
      { id: '2', title: '  community arts grant  ', sponsor: 'OHIO ARTS COUNCIL' },
    ];
    expect(dedupe(opportunities)).toHaveLength(1);
  });

  it('collapses punctuation and word-order paraphrases of one program (the 7x NAEMT class)', () => {
    const opportunities = [
      { id: '1', title: 'NAEMT EMS Scholarship — Paramedic Track', sponsor: 'NAEMT' },
      { id: '2', title: 'Paramedic Track NAEMT EMS Scholarship', sponsor: 'NAEMT' },
      { id: '3', title: 'NAEMT EMS Scholarship - Paramedic Track', sponsor: 'NAEMT' },
    ];
    expect(dedupe(opportunities)).toHaveLength(1);
  });

  it('prefers the external_id tier when a source id is present', () => {
    const a = { external_id: 'GG-12345', title: 'Community Arts Grant', sponsor: 'Ohio Arts Council' };
    const b = { external_id: 'GG-12345', title: 'A totally re-worded listing title', sponsor: 'Ohio Arts Council' };
    expect(canonicalOpportunityKey(a)).toBe(canonicalOpportunityKey(b));
    expect(canonicalOpportunityKey(a).startsWith('ext:')).toBe(true);
  });

  it('keeps genuinely distinct programs separate', () => {
    const opportunities = [
      { id: '1', title: 'Community Arts Grant', sponsor: 'Ohio Arts Council' },
      { id: '2', title: 'Science Education Grant', sponsor: 'National Science Foundation' },
    ];
    const result = dedupe(opportunities);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.id)).toEqual(['1', '2']);
  });

  it('keeps the same title under different sponsors distinct', () => {
    expect(titleIdentityKey('Community Grant', 'Ohio Arts Council')).not.toBe(
      titleIdentityKey('Community Grant', 'Tennessee Arts Commission'),
    );
  });

  it('handles an empty input list without error', () => {
    expect(dedupe([])).toEqual([]);
  });
});
