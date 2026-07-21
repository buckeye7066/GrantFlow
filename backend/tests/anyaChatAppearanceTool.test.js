/**
 * Anya `chat.setAppearance` — the user asks for chat colors in plain language
 * ("dark mode", "make the background navy"); the tool resolves it into a full
 * palette whose text ALWAYS reads at WCAG >= 4.5:1 on its surfaces, so the LLM
 * can never apply an unreadable theme (the exact defect the tool exists to fix).
 *
 * The contrast checker below is implemented INDEPENDENTLY of the tool's own
 * color helpers so a broken implementation cannot vouch for itself.
 */

import { describe, expect, it } from 'vitest'
import { invokeTool } from '../services/anyaToolRegistry.js'

// --- independent WCAG contrast math (do not import from the implementation) ---
function rgb(hex) {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}
function luminance(hex) {
  const lin = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const [r, g, b] = rgb(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
function assertReadable(appearance) {
  expect(contrast(appearance.assistantText, appearance.assistantBubbleBg)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(appearance.userText, appearance.userBubbleBg)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(appearance.bodyText, appearance.panelBg)).toBeGreaterThanOrEqual(4.5)
}

const ctx = { userId: 'u1', isAdmin: false }

describe('chat.setAppearance presets', () => {
  it('dark preset applies a dark, readable palette', async () => {
    const res = await invokeTool('chat.setAppearance', { preset: 'dark' }, { ctx })
    expect(res.output.applied).toBe(true)
    expect(res.output.appearance.isDark).toBe(true)
    assertReadable(res.output.appearance)
  })

  it('high_contrast preset uses pure black text on light surfaces', async () => {
    const res = await invokeTool('chat.setAppearance', { preset: 'high_contrast' }, { ctx })
    expect(res.output.applied).toBe(true)
    expect(res.output.appearance.bodyText).toBe('#000000')
    assertReadable(res.output.appearance)
  })

  it("default preset RESETS: applied with appearance null (the UI's restore signal)", async () => {
    const res = await invokeTool('chat.setAppearance', { preset: 'default' }, { ctx })
    expect(res.output.applied).toBe(true)
    expect(res.output.appearance).toBeNull()
    expect(res.output.description).toMatch(/default/i)
  })
})

describe('chat.setAppearance custom colors', () => {
  it('a custom hex background yields readable text', async () => {
    const res = await invokeTool('chat.setAppearance', { background: '#001f3f' }, { ctx })
    expect(res.output.applied).toBe(true)
    assertReadable(res.output.appearance)
  })

  it('a MID-GRAY background (fails against both inks raw) is nudged until readable', async () => {
    // #808080 vs white text ≈ 3.9:1 and vs black text ≈ 5.3:1 — but derived
    // bubble surfaces can drift into the dead zone; the tool must nudge them.
    const res = await invokeTool('chat.setAppearance', { background: '#808080' }, { ctx })
    assertReadable(res.output.appearance)
  })

  it('supports 3-digit hex', async () => {
    const res = await invokeTool('chat.setAppearance', { background: '#123' }, { ctx })
    expect(res.output.applied).toBe(true)
    assertReadable(res.output.appearance)
  })

  it('rejects a non-hex color with guidance to convert', async () => {
    await expect(invokeTool('chat.setAppearance', { background: 'navy' }, { ctx })).rejects.toThrow(/hex/i)
  })

  it('rejects an empty call', async () => {
    await expect(invokeTool('chat.setAppearance', {}, { ctx })).rejects.toThrow(/preset|background/i)
  })

  it('rejects an unknown preset', async () => {
    await expect(invokeTool('chat.setAppearance', { preset: 'rainbow' }, { ctx })).rejects.toThrow(/unknown preset/i)
  })
})
