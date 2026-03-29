/**
 * @deprecated This migration runner is SQLite-only and should NOT be used.
 * Use `backend/db/migrate.js` instead — it handles both SQLite and PostgreSQL.
 *
 * Running this file directly will exit with an error.
 */

console.error('ERROR: backend/db/migrations/run-migration.js is deprecated and SQLite-only.')
console.error('Use the unified migration runner instead:')
console.error('  node backend/db/migrate.js')
console.error('  or: npm run migrate')
process.exit(1)
