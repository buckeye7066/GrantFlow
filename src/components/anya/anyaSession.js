/**
 * Mint a FRESH Anya session for the panel, scoped to the current profile.
 *
 * OWNER REQUIREMENT: every time Anya is opened the past conversation must not
 * bleed over, while the new conversation stays profile-aware. This helper is
 * the single decision point for "what session does an opened panel get":
 *  - It ALWAYS creates a new session (never resumes a stored one), so opening
 *    starts empty and no prior messages are loaded.
 *  - It threads the current profile id through so the new session is
 *    profile-correct (profile-aware).
 *  - If the supplied profile no longer exists (stale/admin contexts, 404 /
 *    "profile not found"), it falls back to a fresh profile-less session rather
 *    than failing to open.
 *
 * It deliberately does NOT delete prior sessions: past conversations remain
 * stored on the server (audit history preserved) — they just never resurface
 * in the freshly opened panel.
 *
 * @param {{
 *   profileId?: string|null,
 *   title?: string|null,
 *   metadata?: object|null,
 *   createSession: (args: { profileId?: string, title?: string, metadata?: object }) => Promise<{ id?: string }>
 * }} args
 * @returns {Promise<{ session: { id?: string }|null, profileId: string|null }>}
 */
export async function bootstrapAnyaSession({ profileId, title, metadata, createSession }) {
  let desiredProfileId = profileId ?? null
  const buildPayload = (pid) => {
    const payload = { profileId: pid ?? undefined }
    if (title) payload.title = title
    if (metadata && typeof metadata === 'object') payload.metadata = metadata
    return payload
  }
  try {
    const session = await createSession(buildPayload(desiredProfileId))
    return { session: session ?? null, profileId: desiredProfileId }
  } catch (error) {
    const status = error?.status ?? null
    const message = String(error?.message || "")
    const isProfileMissing = status === 404 || /profile not found/i.test(message)
    if (!isProfileMissing) throw error
    // Supplied profile is gone — open a fresh profile-less session instead.
    desiredProfileId = null
    const session = await createSession(buildPayload(undefined))
    return { session: session ?? null, profileId: null }
  }
}
