// Specific, explicitly requested subjects for discovery. These are search
// seeds, never eligibility facts or a substitute for canonical need matching.
export function normalizeDeclaredNeedTerms(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    // financial_information.funding_needs is a budget range, not a subject.
    if (!raw.replace(/\b(?:over|under|between|from|to|up|at|least|most|more|less|than|about|approximately|usd|dollars)\b|[\d\s$,.+\-??]/gi, '').trim()) continue;
    // Keep contact/identifier data out of public search queries.
    if (/@|https?:|www\.|\b\d{3}[- .]\d{2}[- .]\d{4}\b|\b(?:\+?1[- .]?)?\(?\d{3}\)?[- .]\d{3}[- .]\d{4}\b|\d{9,}/i.test(raw)) continue;
    if (/^(?:unknown|unspecified|none|n\/a|not applicable)$/i.test(raw) || /^(?:no|not|without)\s+(?!cost\b)|^(?:do|does)\s+not\s+need/i.test(raw)) continue;
    const term = raw.replace(/_/g, ' ').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (term.length < 3 || term.length > 160 || !/\p{L}{3}/u.test(term) || term.split(' ').length > 20) continue;
    if (!out.includes(term)) out.push(term);
    if (out.length >= 16) break;
  }
  return out;
}
