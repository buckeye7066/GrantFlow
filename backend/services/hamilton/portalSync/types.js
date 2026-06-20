/**
 * portalSync/types.js
 *
 * Type contracts (JSDoc only — no runtime code) for the two-way portal ↔
 * GrantFlow data-sync framework. A "connector" knows how to drive ONE family of
 * portals (matched by host) with an already-authenticated Playwright page:
 *
 *   - READ  : scrape real data out of the portal (test scores, financial-aid
 *             award amounts, application status) and return it in a normalized
 *             shape the framework persists into the profile / pipeline.
 *   - WRITE : push GrantFlow data (the profile's completed-application funding
 *             sources / awards) INTO the portal, where a form for it exists.
 *
 * Honesty contract (enforced by convention, asserted by every connector):
 *   - A connector NEVER fabricates success. If a selector isn't found, it
 *     records the field/award under `notFound` (READ) or `skipped` (WRITE) with
 *     a reason — it does NOT invent a value or claim a write happened.
 *   - Exact DOM selectors for a live portal cannot be verified from here, so a
 *     connector labels every selector it guesses as an ASSUMPTION in comments
 *     and degrades gracefully (collect, don't throw) when the page disagrees.
 *
 * @typedef {Object} PortalSyncContext
 * @property {string}  profileId      Profile the sync runs for (always scoped).
 * @property {string}  portalHost     Normalized host being driven (e.g. mtsu.edu).
 * @property {string}  [actorUserId]  User who initiated the sync (for audit).
 * @property {object}  [profile]      Full profile bundle (base row + sections),
 *                                    used by WRITE to know what to push.
 * @property {object}  [credential]   Decrypted login (server-side only), if one
 *                                    was resolved — never logged or returned.
 * @property {boolean} [hasSession]   Whether a saved Playwright storageState was
 *                                    applied to the context.
 * @property {(msg: string, detail?: any) => void} [log]  Optional trace sink.
 *
 * A single READ-extracted profile field, normalized to a profile_sections
 * target. The framework writes it via profileFieldWriter.setProfileSectionField,
 * so the section/field must be ones the section guard accepts.
 * @typedef {Object} PortalReadField
 * @property {string}  sectionKey  profile_sections section_key (e.g. 'academics').
 * @property {string}  field       field name inside that section (e.g. 'act_score').
 * @property {string|number} value extracted value.
 * @property {string}  [label]     human label for the trace/UI.
 * @property {string}  [source]    where on the page it came from (selector note).
 *
 * A single READ-extracted award (financial aid / scholarship). The framework
 * folds it into the pipeline via the canonical school-portal award path
 * (upsertSchoolPortalAwardAsOpportunity) and respects the DISMISSED gate.
 * @typedef {Object} PortalReadAward
 * @property {string}  title        award name (e.g. 'MTSU True Blue Scholarship').
 * @property {number}  [amount]     numeric amount in dollars when parseable.
 * @property {string}  [amountDisplay] raw amount text as shown on the portal.
 * @property {string}  [status]     'offered'|'accepted'|'disbursed'|raw text.
 * @property {string}  [academicYear] e.g. '2026-2027'.
 * @property {string}  [externalId] portal's own id for the award, if shown.
 * @property {string}  [sponsor]    awarding body (defaults to the school).
 * @property {string}  [sourceUrl]  page the award was read from.
 *
 * @typedef {Object} PortalReadResult
 * @property {PortalReadField[]} fields   normalized profile fields found.
 * @property {PortalReadAward[]} awards   normalized awards found.
 * @property {Array<{kind:'field'|'award'|'status', name:string, reason:string}>} [notFound]
 *           things the connector LOOKED for but could not locate — surfaced
 *           honestly instead of silently dropped.
 * @property {object} [raw]   connector-specific raw capture for debugging.
 *
 * @typedef {Object} PortalWriteResult
 * @property {Array<{target:string, value?:string}>} written  fields/awards the
 *           connector actually wrote into the portal.
 * @property {Array<{target:string, reason:string}>} skipped  things it chose not
 *           to / could not write (no form field, no data, ToS, not found).
 *
 * The connector interface every entry in the registry implements.
 * @typedef {Object} PortalConnector
 * @property {string} id        stable id (e.g. 'mtsu').
 * @property {string} label     human label (e.g. 'Middle Tennessee State University').
 * @property {RegExp} hostMatch matches the portal host(s) this connector drives.
 * @property {(page: import('playwright').Page, ctx: PortalSyncContext) => Promise<PortalReadResult>} read
 * @property {(page: import('playwright').Page, ctx: PortalSyncContext, data: object) => Promise<PortalWriteResult>} write
 */

export {}
