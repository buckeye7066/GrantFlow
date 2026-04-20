/**
 * DEPRECATED: create-orgs-and-grants.mjs
 *
 * This script uses random/placeholder data (random scores, hardcoded reasons) and
 * bypasses the canonical decision engine (computeMatchDecision). It should NOT be
 * used for seeding profile pipelines.
 *
 * For development seeding, use instead:
 *   node backend/scripts/seed-profile-grants.mjs
 *   node backend/scripts/backfill-profile-pipeline-from-opportunities.mjs
 *
 * Both of the above use computeMatchDecision() as the single decision authority.
 *
 * -----------------------------------------------------------------------------
 *  HARD DISABLED
 * -----------------------------------------------------------------------------
 *  The original body of this script has been replaced with an immediate hard
 *  failure. Even in development, running this would insert random scores with
 *  hardcoded explanations directly into the profile pipeline, which:
 *    * contradicts the user rule that computeMatchDecision() is the sole
 *      acceptance/rejection authority,
 *    * poisons the pipeline with synthetic rows that later debugging steps
 *      then treat as real data,
 *    * and cannot be distinguished from real crawler output once inserted.
 *
 *  If you are absolutely sure you need fake data for an isolated unit test,
 *  build a dedicated test fixture instead. Do NOT re-enable this script.
 * -----------------------------------------------------------------------------
 */

throw new Error(
  'DEPRECATED: backend/scripts/create-orgs-and-grants.mjs must not be run ' +
    'because it uses placeholder/random data and bypasses computeMatchDecision(). ' +
    'Use canonical seeding/backfill scripts instead ' +
    '(backend/scripts/seed-profile-grants.mjs, ' +
    'backend/scripts/backfill-profile-pipeline-from-opportunities.mjs).',
)
