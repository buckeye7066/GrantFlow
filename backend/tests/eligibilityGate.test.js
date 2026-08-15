import { describe, it, expect } from 'vitest';

/**
 * Normalize eligibility text: collapse whitespace and strip surrounding punctuation.
 * Uses a proper regex literal to avoid backslash-escape issues in strings.
 */
function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Detect whether an eligibility string mentions a disqualifying "for-profit" clause.
 */
function isNonprofitEligible(eligibilityText) {
  const normalized = normalizeText(eligibilityText);
  const nonprofitPattern = /non[- ]?profit/;
  const forProfitPattern = /for[- ]?profit only/;
  if (forProfitPattern.test(normalized)) {
    return false;
  }
  return nonprofitPattern.test(normalized);
}

/**
 * Validate a currency amount string like "$50,000" or "$1000".
 * Backslashes are represented safely via String.raw to avoid escape errors.
 */
function isValidAmount(amountText) {
  const amountPattern = new RegExp(String.raw`^\$\d{1,3}(,\d{3})*(\.\d{2})?$`);
  return amountPattern.test(String(amountText || '').trim());
}

describe('eligibilityGate', () => {
  it('normalizes whitespace and casing', () => {
    expect(normalizeText('  Nonprofit   Organizations \t Only ')).toBe(
      'nonprofit organizations only',
    );
  });

  it('passes nonprofit-eligible text', () => {
    expect(isNonprofitEligible('Open to nonprofit organizations')).toBe(true);
    expect(isNonprofitEligible('Open to non-profit organizations')).toBe(true);
  });

  it('blocks for-profit-only text', () => {
    expect(isNonprofitEligible('For-profit only businesses')).toBe(false);
  });

  it('validates well-formed currency amounts', () => {
    expect(isValidAmount('$50,000')).toBe(true);
    expect(isValidAmount('$1000')).toBe(true);
    expect(isValidAmount('$1,000.00')).toBe(true);
  });

  it('rejects malformed currency amounts', () => {
    expect(isValidAmount('50000')).toBe(false);
    expect(isValidAmount('$50.000,00')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
  });
});
