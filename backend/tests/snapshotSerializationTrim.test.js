// Guards the 2026-06-23 snapshot-size fix: prepareContextForSnapshot must cap
// heavy document extracted_text (the 1.6MB-avg/24MB-max profile_context_snapshot
// that grew crawler_jobs to 8.3GB) while still converting signal Sets to arrays.

import { describe, it, expect } from 'vitest'
import { prepareContextForSnapshot, restoreContextFromSnapshot } from '../services/snapshotSerialization.js'

describe('prepareContextForSnapshot document trimming', () => {
  it('caps long document extracted_text and records the original length', () => {
    const longText = 'x'.repeat(50000)
    const ctx = { documents: [{ id: 'd1', name: 'big.pdf', mime_type: 'application/pdf', extracted_text: longText }] }
    const out = prepareContextForSnapshot(ctx)
    const doc = out.documents[0]
    expect(doc.extracted_text.length).toBe(4000)
    expect(doc.extracted_text_truncated).toBe(true)
    expect(doc.extracted_text_full_length).toBe(50000)
    // Serialized size is now KB, not MB.
    expect(JSON.stringify(out).length).toBeLessThan(10000)
  })

  it('leaves short document text untouched', () => {
    const ctx = { documents: [{ id: 'd2', name: 'small.txt', extracted_text: 'short body' }] }
    const out = prepareContextForSnapshot(ctx)
    expect(out.documents[0].extracted_text).toBe('short body')
    expect(out.documents[0].extracted_text_truncated).toBeUndefined()
  })

  it('still converts signal Sets to arrays (existing contract)', () => {
    const ctx = { signals: { keywordSet: new Set(['housing', 'medical']), phrases: new Set(['x']) } }
    const out = prepareContextForSnapshot(ctx)
    expect(Array.isArray(out.signals.keywordSet)).toBe(true)
    expect(out.signals.keywordSet).toEqual(['housing', 'medical'])
    // round-trips back to a Set
    const restored = restoreContextFromSnapshot(JSON.parse(JSON.stringify(out)))
    expect(restored.signals.keywordSet instanceof Set).toBe(true)
  })

  it('trims documents even when no signals are present', () => {
    const ctx = { documents: [{ id: 'd3', extracted_text: 'y'.repeat(9000) }] }
    const out = prepareContextForSnapshot(ctx)
    expect(out.documents[0].extracted_text.length).toBe(4000)
  })
})

describe('prepareContextForSnapshot avatar bytes', () => {
  // Live finding 2026-09-11: profiles.avatar_data (BYTEA) rode buildProfileContext's
  // SELECT * into every stored snapshot as a byte-keyed JSON object - 53MB for one
  // JPEG, 2.9MB-average rows, and GET /api/crawlers/jobs timed out shipping them.
  it('drops profile avatar bytes but keeps the avatar reference', () => {
    const bytes = Buffer.alloc(200000, 1)
    const ctx = { profile: { id: 'p1', avatar_url: '/uploads/a.jpg', avatar_data: bytes, avatar_content_type: 'image/jpeg', display_name: 'Fixture' } }
    const out = prepareContextForSnapshot(ctx)
    expect(out.profile.avatar_data).toBeUndefined()
    expect(out.profile.avatar_url).toBe('/uploads/a.jpg')
    expect(out.profile.avatar_content_type).toBe('image/jpeg')
    expect(out.profile.display_name).toBe('Fixture')
    expect(JSON.stringify(out).length).toBeLessThan(1000)
    // The caller's live context is not mutated.
    expect(ctx.profile.avatar_data).toBe(bytes)
  })
})
