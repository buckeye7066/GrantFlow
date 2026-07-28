// @vitest-environment jsdom
/**
 * Anya chat contrast guards (owner report 2026-07-27: "the background is the
 * same as the text" — in default dark mode AND under every chat.setAppearance
 * look Anya applied).
 *
 * Three layers were fighting:
 *   1. Bubble/surface classes had light backgrounds with no dark: variants.
 *   2. index.css GLOBAL !important dark-mode remaps (.dark .bg-white → card,
 *      .dark .text-slate-800 → light) BEAT Anya's inline appearance styles,
 *      half-overriding every custom look.
 *   3. Text elements styled by theme classes fought inline-styled surfaces
 *      whenever app-theme lightness and appearance lightness disagreed.
 *
 * These tests pin all three fixes.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

// AnyaChat pulls heavy app modules at import time; stub the network-touching
// client so importing the module is side-effect-safe under jsdom.
// AnyaMessageBubble is deliberately light — no store/api imports needed.

const { MessageBubble } = await import('../AnyaMessageBubble.jsx')

const MSG = { id: 'm1', role: 'assistant', content: 'Has the FAFSA been started?', created_at: null }

describe('MessageBubble default (no custom appearance)', () => {
  it('assistant and user bubbles pair every surface with a dark: variant', () => {
    const { container: a } = render(<MessageBubble message={MSG} appearance={null} />)
    const aCls = a.firstChild.className
    expect(aCls).toContain('dark:bg-blue-950/60')
    expect(aCls).toContain('dark:text-slate-100')

    const { container: u } = render(
      <MessageBubble message={{ ...MSG, role: 'user' }} appearance={null} />,
    )
    const uCls = u.firstChild.className
    expect(uCls).toContain('dark:bg-slate-800')
    expect(uCls).toContain('dark:text-slate-200')
  })
})

describe('MessageBubble under a custom appearance', () => {
  const APPEARANCE = {
    panelBg: '#ffffff', composerBg: '#f5f6f8',
    assistantBubbleBg: '#f4f5f7', userBubbleBg: '#fafafa',
    bodyText: '#000000', assistantText: '#000000', userText: '#000000',
    mutedText: '#1e293b', border: '#0f172a', isDark: false, label: 'high contrast',
  }

  it('paints background AND text inline from the appearance (both must move together)', () => {
    const { container } = render(<MessageBubble message={MSG} appearance={APPEARANCE} />)
    const el = container.firstChild
    expect(el.style.background).toBeTruthy()
    expect(el.style.color).toBe('rgb(0, 0, 0)')
  })
})

describe('index.css global remap exemptions (the !important-beats-inline class)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../../index.css'), 'utf8')

  it('TOTALITY: every global !important remap excludes the appearance-active subtree', () => {
    // Any `.dark :is(...)`, `:root:not(.dark) :is(...)` or `.high-contrast
    // :is(...)` remap that forces color/background with !important must carry
    // the anya exclusion — a new remap without it re-creates the bug.
    // Multi-line `:is(` openers are the ::placeholder blocks — they style
    // placeholder text only, which lives in class-paired inputs (readable
    // islands) and cannot fight an inline-styled appearance surface.
    const remapLines = css.split('\n').filter((l) =>
      /^(\s*)(\.dark|:root:not\(\.dark\)|\.high-contrast)\s+:is\(.+\)/.test(l) && !l.includes('::placeholder'))
    expect(remapLines.length).toBeGreaterThanOrEqual(7)
    for (const line of remapLines) {
      expect(line, `remap missing anya exemption: ${line.trim()}`).toContain('anya-appearance-active')
    }
  })

  it('the appearance subtree forces text inheritance from inline-styled surfaces', () => {
    expect(css).toMatch(/\.anya-appearance-active :where\([^)]*p, span[^)]*\):not\(\[class\*="bg-"\]\)\s*\{\s*color: inherit !important/)
  })

  it('AnyaChat scopes the panel with the appearance class and CSS variables', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../AnyaChat.jsx'), 'utf8')
    expect(src).toContain('"anya-appearance-active"')
    expect(src).toContain('"--anya-text"')
    expect(src).toContain('"--anya-muted"')
  })
})
