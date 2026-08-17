import {
  OrganizationProfile,
  normalizeProfile,
} from '../types/organization';

export const STORAGE_KEY = 'grantflow.orgProfile';

export type SaveResult = { ok: true } | { ok: false };

// Read the saved profile. Returns null if nothing is saved, or if the saved
// value is missing/corrupt/unreadable — never throws, so a bad value simply
// shows the welcome screen instead of a broken page.
export function loadProfile(): OrganizationProfile | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw == null || raw === '') return null;
    const parsed = JSON.parse(raw);
    return normalizeProfile(parsed);
  } catch {
    return null;
  }
}

// Write the profile to this device. Returns { ok: true } on success or
// { ok: false } if saving failed (private mode, full storage, storage off),
// so the caller can show a plain retry message and keep the typed data.
export function saveProfile(profile: OrganizationProfile): SaveResult {
  try {
    if (!globalThis.localStorage) return { ok: false };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Remove the saved profile (used mainly by tests / a possible future reset).
export function clearProfile(): SaveResult {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
