import { describe, expect, it, vi } from "vitest"

import { bootstrapAnyaSession } from "./anyaSession.js"

// These tests pin the OWNER REQUIREMENT for the Anya chat panel:
//   "Each time Anya is opened, the past conversation needs to be deleted so it
//    doesn't bleed over. It also needs to stay profile aware."
//
// The bleed-over used to come from the bootstrap resuming the most recent
// stored session for the current profile and reloading its messages. The fix
// routes every open through `bootstrapAnyaSession`, which ALWAYS mints a brand
// new session (no resume, no message reload) while staying profile-scoped.
describe("bootstrapAnyaSession", () => {
  it("always creates a brand-new session (never resumes a stored one)", async () => {
    const createSession = vi
      .fn()
      .mockResolvedValueOnce({ id: "session-1" })
      .mockResolvedValueOnce({ id: "session-2" })

    // First open
    const first = await bootstrapAnyaSession({ profileId: "profile-A", createSession })
    // Second open (simulates closing + re-opening the panel, which remounts)
    const second = await bootstrapAnyaSession({ profileId: "profile-A", createSession })

    // A fresh session is minted on each open — no bleed-over from the prior one.
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(first.session.id).toBe("session-1")
    expect(second.session.id).toBe("session-2")
    expect(first.session.id).not.toBe(second.session.id)
  })

  it("stays profile-aware: threads the current profile id into the new session", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-x" })

    const result = await bootstrapAnyaSession({ profileId: "profile-B", createSession })

    expect(createSession).toHaveBeenCalledWith({ profileId: "profile-B" })
    expect(result.profileId).toBe("profile-B")
  })

  it("passes safe session title and metadata into the fresh session", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-plan" })

    await bootstrapAnyaSession({
      profileId: "profile-plan",
      title: "Food truck launch action plan interview",
      metadata: { source: "profile_action_plan", plan_id: "food_truck_startup" },
      createSession,
    })

    expect(createSession).toHaveBeenCalledWith({
      profileId: "profile-plan",
      title: "Food truck launch action plan interview",
      metadata: { source: "profile_action_plan", plan_id: "food_truck_startup" },
    })
  })

  it("opens a profile-less session for a null profile (admin/no-profile context)", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-admin" })

    const result = await bootstrapAnyaSession({ profileId: null, createSession })

    expect(createSession).toHaveBeenCalledWith({ profileId: undefined })
    expect(result.profileId).toBeNull()
    expect(result.session.id).toBe("session-admin")
  })

  it("falls back to a fresh profile-less session when the profile is gone (404)", async () => {
    const notFound = Object.assign(new Error("profile not found"), { status: 404 })
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ id: "session-fallback" })

    const result = await bootstrapAnyaSession({ profileId: "stale-profile", createSession })

    expect(createSession).toHaveBeenNthCalledWith(1, { profileId: "stale-profile" })
    expect(createSession).toHaveBeenNthCalledWith(2, { profileId: undefined })
    expect(result.profileId).toBeNull()
    expect(result.session.id).toBe("session-fallback")
  })

  it("re-throws non-profile errors instead of masking them", async () => {
    const boom = Object.assign(new Error("network down"), { status: 500 })
    const createSession = vi.fn().mockRejectedValue(boom)

    await expect(
      bootstrapAnyaSession({ profileId: "profile-C", createSession }),
    ).rejects.toThrow("network down")
    // No fallback session is created for an unexpected failure.
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
