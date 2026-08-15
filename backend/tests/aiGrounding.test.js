import { describe, it, expect } from 'vitest';

/**
 * Simplified grounding checker used by these tests.
 * Returns true only when every claimed field value appears in the source text.
 */
function isGrounded(sourceText, claims) {
  if (!sourceText || typeof sourceText !== 'string') {
    return false;
  }
  const haystack = sourceText.toLowerCase();
  return Object.values(claims).every((value) => {
    if (value === null || value === undefined) {
      return true;
    }
    return haystack.includes(String(value).toLowerCase());
  });
}

describe('aiGrounding', () => {
  it('accepts claims fully supported by the source text', () => {
    const source =
      'The Community Arts Grant offers up to $50000 for nonprofit organizations in Ohio.';
    const claims = {
      amount: '$50000',
      region: 'Ohio',
      eligibility: 'nonprofit',
    };
    expect(isGrounded(source, claims)).toBe(true);
  });

  it('rejects claims that are not present in the source text', () => {
    const source = 'The grant offers up to $50000 for nonprofits in Ohio.';
    const claims = {
      amount: '$50000',
      region: 'California',
    };
    expect(isGrounded(source, claims)).toBe(false);
  });

  it('treats null and undefined claim values as trivially grounded', () => {
    const source = 'Some grant text.';
    const claims = {
      amount: null,
      region: undefined,
    };
    expect(isGrounded(source, claims)).toBe(true);
  });

  it('returns false when the source text is missing', () => {
    const claims = { amount: '$1000' };
    expect(isGrounded('', claims)).toBe(false);
    expect(isGrounded(null, claims)).toBe(false);
  });
});
