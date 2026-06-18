/**
 * profileSectionSync.js
 *
 * Syncs key profile section fields to the profiles table for fast shallow reads.
 * This ensures that matching, Anya, and listing queries can use profiles.state,
 * profiles.categories, etc. without needing to parse profile_sections JSON.
 *
 * Call syncProfileFieldsFromSections() after any profile section update.
 */

import { normalizeState } from './stateNormalization.js';
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js';

/**
 * Mapping of section fields → profiles table columns.
 * Each entry: { sectionKey, sectionField, profileColumn, transform? }
 */
const SYNC_RULES = [
  {
    sectionKey: 'basic_information',
    sectionField: 'full_name',
    profileColumn: 'display_name',
    transform: (v) => {
      const trimmed = typeof v === 'string' ? v.trim() : String(v ?? '').trim()
      return trimmed.length >= 2 ? trimmed.slice(0, 200) : null
    },
  },
  {
    sectionKey: 'basic_information',
    sectionField: 'state',
    profileColumn: 'state',
    transform: (v) => normalizeState(v),
  },
  {
    sectionKey: 'basic_information',
    sectionField: 'zip',
    profileColumn: 'zip',
    transform: (v) => typeof v === 'string' ? v.trim().replace(/\D/g, '').slice(0, 5) || null : null,
  },
  {
    sectionKey: 'basic_information',
    sectionField: 'city',
    profileColumn: 'city',
    transform: null,
  },
  {
    sectionKey: 'basic_information',
    sectionField: 'county',
    profileColumn: 'county',
    transform: null,
  },
  {
    sectionKey: 'demographics',
    sectionField: 'is_veteran',
    profileColumn: 'serves_veterans',
    transform: (v) => v === true || v === 'true' || v === 1 ? 1 : 0,
  },
  {
    sectionKey: 'health_medical',
    sectionField: 'has_disability',
    profileColumn: 'serves_disabled',
    transform: (v) => v === true || v === 'true' || v === 1 ? 1 : 0,
  },
  {
    sectionKey: 'military_service',
    sectionField: 'veteran_status',
    profileColumn: 'serves_veterans',
    transform: (v) => v && v !== 'none' && v !== 'no' ? 1 : 0,
  },
];

/**
 * After a section is saved, sync any relevant fields to the profiles table.
 * Only updates columns when the section field has a non-null value.
 *
 * @param {Object} db - Database handle
 * @param {string} profileId - Profile ID
 * @param {string} sectionKey - Which section was just updated
 * @param {Object} sectionData - The parsed section data object
 */
export function syncProfileFieldsFromSection(db, profileId, sectionKey, sectionData) {
  if (!db || !profileId || !sectionKey || !sectionData) return;

  const applicableRules = SYNC_RULES.filter(r => r.sectionKey === sectionKey);
  if (applicableRules.length === 0) return;

  for (const rule of applicableRules) {
    const rawValue = sectionData[rule.sectionField];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    const finalValue = rule.transform ? rule.transform(rawValue) : rawValue;
    if (finalValue === null || finalValue === undefined) continue;

    try {
      // Check if the column exists before trying to update
      db.prepare(`UPDATE profiles SET ${rule.profileColumn} = ? WHERE id = ?`).run(finalValue, profileId);
    } catch (err) {
      // Column may not exist in the profiles table — this is not fatal
      if (!String(err?.message).includes('no such column') && !String(err?.message).includes('does not exist')) {
        console.warn(`[profileSectionSync] Failed to sync ${rule.profileColumn} for profile ${profileId}:`, err.message);
      }
    }
  }
}

/**
 * Full re-sync of all section data to profiles table.
 * Use after initial profile creation or data migration.
 *
 * @param {Object} db - Database handle
 * @param {string} profileId - Profile ID
 */
export function fullResyncProfileFields(db, profileId) {
  if (!db || !profileId) return;

  try {
    const rows = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId);
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data || '{}');
        syncProfileFieldsFromSection(db, profileId, row.section_key, data);
      } catch { /* skip unparseable sections */ }
    }
  } catch (err) {
    console.warn(`[profileSectionSync] fullResync failed for profile ${profileId}:`, err.message);
  }
}

/**
 * Keep basic_information.full_name aligned when the profile title changes.
 */
export async function syncDisplayNameToBasicInformation(db, profileId, displayName) {
  if (!db || !profileId) return

  const trimmed = String(displayName || '').trim()
  if (trimmed.length < 2) return

  let existing = {}
  try {
    const row = await db
      .prepare(
        'SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1',
      )
      .get(profileId, 'basic_information')
    if (row?.data) {
      existing = typeof row.data === 'object' ? row.data : JSON.parse(row.data || '{}')
    }
  } catch {
    existing = {}
  }

  let merged = { ...existing, full_name: trimmed.slice(0, 200) }

  // "Parse, baby, parse." Derive first_name/last_name from the full name so
  // Hamilton's preflight (which requires those decomposed fields) stops
  // flagging them as missing. Never clobbers a name a human already entered.
  merged = deriveNamePartsIntoBasicInfo(merged, trimmed).data

  await db
    .prepare(
      `
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, 'basic_information', ?, 'display-name-sync')
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(profileId, JSON.stringify(merged))
}

export default { syncProfileFieldsFromSection, fullResyncProfileFields, syncDisplayNameToBasicInformation };
