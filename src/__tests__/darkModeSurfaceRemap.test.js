/**
 * Dark-mode surface remap coverage (owner report 2026-09-07, "Billing Snapshot":
 * light-gray stat tiles on a near-black page with mid-gray text on them).
 *
 * The app is light-first: hundreds of components hard-code light Tailwind
 * surfaces (bg-white, bg-slate-50/80, bg-slate-200 ...) with no dark: variant.
 * src/index.css remaps those surfaces AND their text under `.dark` so both flip
 * together. The 2026-09-07 defect was a coverage hole: the surface list named
 * `.bg-slate-50` but not its OPACITY variants, so `bg-slate-50/80` stayed light
 * while `text-slate-500` on it was remapped for a dark surface (~1.9:1).
 *
 * These tests make that hole structurally impossible:
 *   1. TOTALITY — every light-surface utility actually used in src/ (opacity
 *      and hover variants included) is named in a `.dark` background remap.
 *   2. CONTRAST — the remapped text inks clear WCAG AA against every remapped
 *      dark surface, and the light-mode inks clear AA on the light tints.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '..')
const css = fs.readFileSync(path.join(SRC_ROOT, 'index.css'), 'utf8')

// Light-fixed surface utilities that MUST be darkened under `.dark`.
// bg-white/20 and /15 are translucent highlights painted OVER a colored or dark
// hero surface (Start.jsx badge, GrantOverview chip); bg-white/40 is the count
// chip inside a colored Badge. Darkening those would paint a black box on a
// colored surface, so they are deliberately exempt and listed here by name.
const SURFACE_RX = /\b(?:hover:)?bg-(?:white|slate-(?:50|100|200)|gray-(?:50|100|200)|current-card|current-paper)(?:\/\d+)?\b/g
const TRANSLUCENT_OVERLAYS = new Set(['bg-white/40', 'bg-white/20', 'bg-white/15'])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(full, out)
      continue
    }
    if (!/\.(jsx?|tsx?)$/.test(entry.name)) continue
    if (/\.test\.(jsx?|tsx?)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

function usedLightSurfaces() {
  const used = new Map()
  for (const file of walk(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(SURFACE_RX)) {
      const cls = m[0]
      if (TRANSLUCENT_OVERLAYS.has(cls)) continue
      if (!used.has(cls)) used.set(cls, path.relative(SRC_ROOT, file))
    }
  }
  return used
}

/** Every class token named by a `.dark :is(...)` remap whose declaration sets background-color. */
function darkRemappedSurfaces() {
  const covered = new Set()
  const blockRx = /^\s*\.dark\s+:is\(([^\n]*?)\):not\([^\n]*\)\s*\{\s*\n\s*background-color:/gm
  for (const m of css.matchAll(blockRx)) {
    for (const raw of m[1].split(',')) {
      const token = raw.trim().replace(/^\./, '').replace(/\\\//g, '/').replace(/\\:/g, ':').replace(/:hover$/, '')
      if (token) covered.add(token)
    }
  }
  return covered
}

// ---------- contrast math (WCAG 2.1) ----------
function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
function luminanceRgb([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function hslToRgb(h, s, l) {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255))
}
function contrast(a, b) {
  const la = luminanceRgb(a)
  const lb = luminanceRgb(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
/** Read `--token: H S% L%` out of a CSS block selected by its opening selector. */
function readHslToken(selector, token) {
  const start = css.indexOf(`${selector} {`)
  expect(start, `block ${selector} not found in index.css`).toBeGreaterThan(-1)
  const block = css.slice(start, css.indexOf('}', start))
  const m = block.match(new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`))
  expect(m, `--${token} not defined in ${selector}`).toBeTruthy()
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
}
/** Read the `color: rgb(r g b)` a `.dark` remap assigns to the given text utility. */
function darkInkFor(textClass) {
  // Tailwind escapes "/" as "\/" in the emitted selector; match that literal form.
  const escaped = textClass.replace(/\//g, '\\\\/')
  const rx = new RegExp(`^\\s*\\.dark\\s+:is\\([^\\n]*\\.${escaped}[,)][^\\n]*\\{\\s*\\n\\s*color:\\s*rgb\\((\\d+)\\s+(\\d+)\\s+(\\d+)\\)`, 'm')
  const m = css.match(rx)
  expect(m, `no .dark ink remap found for .${textClass}`).toBeTruthy()
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe('dark-mode surface remap — TOTALITY', () => {
  const used = usedLightSurfaces()
  const covered = darkRemappedSurfaces()

  it('scans real usage (sanity: the Billing Snapshot tile class is in play)', () => {
    expect(used.has('bg-slate-50/80')).toBe(true)
    expect(used.size).toBeGreaterThan(10)
  })

  it('every light-surface utility used in src/ is darkened under .dark (opacity + hover variants included)', () => {
    const missing = [...used.entries()]
      .filter(([cls]) => !covered.has(cls))
      .map(([cls, file]) => `${cls} (first seen in ${file})`)
    expect(missing, `add these to the .dark surface remap in src/index.css:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('the regression classes are named explicitly', () => {
    for (const cls of ['bg-slate-50/80', 'bg-slate-50/60', 'bg-slate-50/50', 'bg-slate-200', 'bg-gray-200', 'hover:bg-slate-50', 'bg-current-card']) {
      expect(covered.has(cls), `${cls} must be remapped`).toBe(true)
    }
  })
})

describe('dark-mode surface remap — CONTRAST (WCAG AA)', () => {
  const muted = readHslToken('.dark', 'muted')
  const card = readHslToken('.dark', 'card')
  const hover = readHslToken('.dark', 'surface-hover')
  const heading = darkInkFor('text-slate-900')
  const label = darkInkFor('text-slate-500')
  const ink = darkInkFor('text-current-ink')
  const inkMuted = darkInkFor('text-current-ink/60')

  it('heading/value ink clears 4.5:1 on every darkened surface', () => {
    for (const [name, bg] of [['muted', muted], ['card', card], ['surface-hover', hover]]) {
      expect(contrast(heading, bg), `text-slate-900 remap on ${name}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(ink, bg), `text-current-ink remap on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('muted label ink (the 11px "Reason:" line) clears 4.5:1 on every darkened surface', () => {
    for (const [name, bg] of [['muted', muted], ['card', card], ['surface-hover', hover]]) {
      expect(contrast(label, bg), `text-slate-500 remap on ${name}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(inkMuted, bg), `text-current-ink/60 remap on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('tinted surfaces sit one step ABOVE the card so a tile inside a card keeps its box', () => {
    expect(luminanceRgb(muted)).toBeGreaterThan(luminanceRgb(card))
    expect(luminanceRgb(hover)).toBeGreaterThan(luminanceRgb(muted))
  })

  it('light mode: the remapped slate-700 label ink clears 4.5:1 on every light tint', () => {
    const lightLabel = css.match(/:root:not\(\.dark\)\s+:is\([^\n]*\.text-slate-500[^\n]*\{\s*\n\s*color:\s*rgb\((\d+)\s+(\d+)\s+(\d+)\)/m)
    expect(lightLabel).toBeTruthy()
    const labelRgb = [Number(lightLabel[1]), Number(lightLabel[2]), Number(lightLabel[3])]
    for (const [name, hex] of [['slate-50', '#f8fafc'], ['slate-100', '#f1f5f9'], ['slate-200', '#e2e8f0'], ['white', '#ffffff'], ['current-card', '#FBFCFA'], ['current-paper', '#F2F5F1']]) {
      expect(contrast(labelRgb, hexToRgb(hex)), `light label on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
