/**
 * GET /api/grants pages with validatePagination: omitting `limit` returns a
 * DEFAULT page of 100 rows as a bare array (no pagination metadata), and the
 * server clamps any limit to MAX_PAGE_LIMIT = 1000 (backend/config/constants.js).
 * Every screen that counts, sums, charts or picks from "all grants" must ask
 * for the full set explicitly, or it silently analyzes a truncated subset
 * (production 2026-09-11: Reports showed 0 awarded / 1 submitted of 125).
 */
export const GRANT_LIST_FULL_LIMIT = 1000
