#!/usr/bin/env node
/**
 * DEPRECATED: scripts/prepopulate-grant-matches.mjs
 *
 * This script previously used a LOCAL, hand-rolled score-only matcher (not the
 * canonical engine) to insert Firestore organization grants whenever its raw
 * score was >= 80. That violates two repo rules:
 *
 *   1. No legacy score-only acceptance logic may remain in active scripts.
 *      Only `computeMatchDecision()` in backend/services/matchEngine.js is
 *      allowed to accept or reject.
 *   2. No insertion path may bypass the canonical decision engine.
 *
 * The previous implementation also wrote to a separate Firestore surface and
 * could not realistically be re-routed through the canonical engine without a
 * significant rewrite. Rather than leave a dangerous shortcut in the tree, the
 * script is hard-disabled. Use the SQLite-backed canonical seeders instead:
 *
 *   node scripts/seed-profile-grants.mjs
 *   node backend/scripts/backfill-profile-pipeline-from-opportunities.mjs
 */

throw new Error(
  'DEPRECATED: scripts/prepopulate-grant-matches.mjs must not be run. It used ' +
    'a local score-only matcher as an acceptance authority, bypassing ' +
    'computeMatchDecision(). Use the canonical seeders instead ' +
    '(scripts/seed-profile-grants.mjs or ' +
    'backend/scripts/backfill-profile-pipeline-from-opportunities.mjs).',
)
