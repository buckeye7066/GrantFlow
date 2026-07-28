/**
 * A random identifier minted once per Node process.
 *
 * WHY THIS EXISTS: an external auditor (GitHub Actions, with no Railway
 * credentials) needs to prove that a posture record it reads out of the
 * database was written by the process that is *currently serving traffic* —
 * not by a previous deploy that happened to have safer settings.
 *
 * `system_kv.automation_posture` carries this id, and GET /api/health/deployment
 * reports the same id. Equality is the proof. A timestamp cannot do this job:
 * a process may legitimately run for weeks, so "recent" and "current" are
 * different claims, and only the second one is safe to act on.
 */

import { randomUUID } from 'node:crypto'

export const BOOT_ID = randomUUID()
