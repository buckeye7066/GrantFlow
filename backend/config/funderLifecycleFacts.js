// backend/config/funderLifecycleFacts.js
//
// Funder-aware lifecycle facts captured from a funder's OWN page and persisted on
// funding_opportunities, so the profile calendar can show the two cornerstones
// that only the funder can state: when a decision is expected, and what
// post-award follow-ups the funder requires. Every value is normalized here on
// the WRITE side; the calendar derivation (services/calendar/pipelineLifecycleEvents.js)
// omits anything it still cannot resolve to a real date. Nothing here influences
// matching, eligibility, geography, or amount — these are display cornerstones only.
//
// Columns (migration 0187 / 182):
//   expected_decision_date  — a concrete "awards announced on <date>" the funder stated (date).
//   decision_review_days    — a stated review LENGTH ("decisions within 90 days") (integer),
//                             from which the calendar derives a clearly-LABELED estimate.
//   reporting_requirements  — JSON array of funder follow-ups (jsonb / TEXT):
//                             [{label, offset_days?, anchor?:'award_date'|'submitted_date', due_date?}]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPORTING_ANCHORS = new Set(['award_date', 'submitted_date']);
const MAX_REVIEW_DAYS = 1825; // 5 years — a plausible ceiling; anything larger is junk
const MAX_REPORTING_ITEMS = 12;
const MAX_REPORTING_LABEL = 200;

/**
 * A real 'YYYY-MM-DD' calendar date, or null. Round-trips every component so a
 * rollover (2026-13-40) can never survive as a finite Date.
 * @param {*} value
 * @returns {string|null}
 */
export function normalizeExpectedDecisionDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!ISO_DATE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())
    || dt.getUTCFullYear() !== y
    || dt.getUTCMonth() + 1 !== m
    || dt.getUTCDate() !== d) return null;
  return s;
}

/**
 * A positive whole number of review days in [1, 1825], or null. Accepts a number
 * or a plain-integer string; rejects everything else (never coerces "" -> 0).
 * @param {*} value
 * @returns {number|null}
 */
export function normalizeDecisionReviewDays(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1 || i > MAX_REVIEW_DAYS) return null;
  return i;
}

/**
 * A normalized array of funder follow-up requirements, or null. Each surviving
 * entry carries a non-empty label plus whatever date basis the funder stated:
 * an absolute `due_date`, an `offset_days` (with optional `anchor`). A label-only
 * entry is kept (future-proof) but will be SKIPPED by the derivation until it has
 * a resolvable date — the calendar never invents one.
 * Accepts an array or a JSON string (as the crawler stores it).
 * @param {*} value
 * @returns {Array<object>|null}
 */
export function normalizeReportingRequirements(value) {
  let arr = value;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const label = typeof item.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, MAX_REPORTING_LABEL) : '';
    if (!label) continue;
    const entry = { label };
    const due = normalizeExpectedDecisionDate(item.due_date);
    if (due) entry.due_date = due;
    const off = normalizeDecisionReviewDays(item.offset_days);
    if (off !== null) entry.offset_days = off;
    if (typeof item.anchor === 'string' && REPORTING_ANCHORS.has(item.anchor.trim())) {
      entry.anchor = item.anchor.trim();
    }
    out.push(entry);
    if (out.length >= MAX_REPORTING_ITEMS) break;
  }
  return out.length ? out : null;
}

export default {
  normalizeExpectedDecisionDate,
  normalizeDecisionReviewDays,
  normalizeReportingRequirements,
};
