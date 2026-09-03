/**
 * opportunityKindClasses.js — which `opportunity_kind` values can carry a
 * per-award dollar figure at all.
 *
 * WHY THIS EXISTS (2026-08-01). Anya's report said:
 *
 *   "2 active pipeline grant(s) were READ but their source could not be parsed
 *    (JS shell / dead page) — they need an API adapter. Top host(s):
 *    nfb.org ×1, scholarships.com ×1."
 *
 * Both rows are POINTERS, not awards — `www.scholarships.com` is a scholarship
 * DIRECTORY (a list of other people's scholarships) and the nfb.org row is a
 * REFERRAL. CLAUDE.md is explicit that a locator "is a pointer, never an award"
 * and carries no per-award amount BY DESIGN, so an adapter there could not
 * yield a figure however well it was written — and the sweep had already spent
 * fetch attempts on each chasing one. The finding named work that cannot exist.
 *
 * The cause was a HAND-TYPED subset. `pipeline.amountCoverage` classified only
 * `('directory', 'benefit')` as no-figure-by-design, while prod's catalog
 * carries five pointer-ish kinds (measured 2026-08-01):
 *
 *   directory 4270 | DIRECTORY 224 | referral 119 | school_portal 102
 *
 * `referral` and `school_portal` fell through the hand-typed list into the
 * `unanswered_unreadable` bucket — the ONE bucket that reds the owner's report
 * and names adapter work.
 *
 * CASING IS INCONSISTENT ON PURPOSE-BY-ACCIDENT: prod holds `directory` AND
 * `DIRECTORY`, `benefit` AND `BENEFIT`, and CLAUDE.md documents a whole
 * tug-of-war over who owns the column. Every predicate here therefore compares
 * LOWER-cased, and the registry below is the single list — never a string typed
 * at a call site.
 *
 * REGISTRY + TOTALITY (CLAUDE.md): the same set already existed as a literal
 * inside `services/matching/matchDecisionIntegrity.js` (`RESOURCE_KINDS_SQL`).
 * A static drift tripwire in `backend/tests/opportunityKindClasses.test.js`
 * asserts the two cannot diverge.
 */

/**
 * A POINTER: the row's contract is to send you somewhere else. It never states
 * an award because there is no award — the money belongs to whoever the pointer
 * points at. Mirrors `matchDecisionIntegrity.RESOURCE_KINDS_SQL`.
 */
export const POINTER_KINDS = Object.freeze([
  'directory',
  'past_award_intel',
  'school_portal',
  'referral',
])

/**
 * A BENEFIT program (SSA survivor/disability, FAFSA/Pell/SSI, LIHEAP) states no
 * fixed per-applicant figure: the amount is computed from the applicant's own
 * circumstances. Distinct from a pointer — it IS the thing you apply to — but
 * equally incapable of publishing a per-award ceiling.
 */
export const NO_FIXED_AWARD_KINDS = Object.freeze(['benefit'])

/**
 * The union: kinds that cannot carry a per-award dollar figure BY DESIGN. A row
 * of one of these kinds with no amount is ANSWERED, never a crawler miss and
 * never an adapter gap.
 */
export const NO_PER_AWARD_FIGURE_KINDS = Object.freeze([
  ...POINTER_KINDS,
  ...NO_FIXED_AWARD_KINDS,
])

const quoteList = (kinds) => kinds.map((k) => `'${k}'`).join(', ')

/**
 * SQL predicate: does this row's kind publish no per-award figure by design?
 * Dialect-agnostic (LOWER + COALESCE work identically on SQLite and Postgres).
 *
 * @param {string} column fully-qualified kind column, e.g. `fo.opportunity_kind`
 */
export function noPerAwardFigureKindSql(column) {
  return `LOWER(COALESCE(CAST(${column} AS TEXT), '')) IN (${quoteList(NO_PER_AWARD_FIGURE_KINDS)})`
}

/** SQL predicate for POINTER kinds only (no benefit programs). */
export function pointerKindSql(column) {
  return `LOWER(COALESCE(CAST(${column} AS TEXT), '')) IN (${quoteList(POINTER_KINDS)})`
}

/** JS-side twin of `noPerAwardFigureKindSql`, for rows already in memory. */
export function isNoPerAwardFigureKind(kind) {
  return NO_PER_AWARD_FIGURE_KINDS.includes(String(kind ?? '').trim().toLowerCase())
}

/**
 * JS-side twin of `pointerKindSql`, for rows already in memory.
 *
 * POINTERS ONLY — deliberately NOT the `NO_PER_AWARD_FIGURE_KINDS` union. A
 * BENEFIT program (Pell, SSI, LIHEAP) publishes no fixed figure but IS the
 * thing you apply to, so a consumer asking "did this profile actually get
 * something it can apply to?" must count a benefit as a real award. Prod
 * 2026-08-01 holds 668 benefit catalog rows behind 511 match rows; folding
 * them in here would misreport those profiles as having received only
 * pointers.
 */
export function isPointerKind(kind) {
  return POINTER_KINDS.includes(String(kind ?? '').trim().toLowerCase())
}

export default {
  POINTER_KINDS,
  NO_FIXED_AWARD_KINDS,
  NO_PER_AWARD_FIGURE_KINDS,
  noPerAwardFigureKindSql,
  pointerKindSql,
  isNoPerAwardFigureKind,
  isPointerKind,
}
