// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// settingsStore is the SINGLE source of truth for theme — it owns the .dark class
// and accent CSS vars. These tests assert that applier behavior + the localStorage
// cache + the one-time migration from the legacy DashboardPreferencesContext store.
// Echo the PUT body back like the real backend (which returns the saved prefs),
// so the post-save merge keeps the chosen value instead of resetting to defaults.
vi.mock('@/api/client', () => ({
  apiFetch: vi.fn(async (_url, opts) => {
    if (opts?.body) {
      try { return JSON.parse(opts.body) } catch { return {} }
    }
    return {}
  }),
}))
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }))

import { pickReadableForegroundHex, useSettingsStore } from '@/stores/settingsStore'

const BASE_PREFS = {
  theme: 'light',
  accent_color: 'blue',
  font_size: 'medium',
  high_contrast: false,
  reduce_motion: false,
}

describe('settingsStore — single-source theme applier', () => {
  beforeEach(() => {
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    useSettingsStore.setState({ preferences: { ...BASE_PREFS } })
  })

  it('toggles the .dark class on documentElement from theme alone', () => {
    useSettingsStore.setState({ preferences: { ...BASE_PREFS, theme: 'dark' } })
    useSettingsStore.getState().applyTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    useSettingsStore.setState({ preferences: { ...BASE_PREFS, theme: 'light' } })
    useSettingsStore.getState().applyTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('applies the accent CSS variable, including emerald/violet (previously fell back to blue)', () => {
    useSettingsStore.setState({ preferences: { ...BASE_PREFS, accent_color: 'emerald' } })
    useSettingsStore.getState().applyTheme()
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#10b981')

    useSettingsStore.setState({ preferences: { ...BASE_PREFS, accent_color: 'violet' } })
    useSettingsStore.getState().applyTheme()
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#8b5cf6')
  })

  it.each([
    '#3b82f6',
    '#a855f7',
    '#22c55e',
    '#f97316',
    '#f43f5e',
    '#06b6d4',
    '#f59e0b',
    '#ec4899',
    '#10b981',
    '#8b5cf6',
  ])('chooses a black/white foreground with WCAG AA contrast for %s', (background) => {
    const toLuminance = (hex) => {
      const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255)
      const [r, g, b] = channels.map((value) => (
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      ))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const foreground = pickReadableForegroundHex(background)
    const backgroundLum = toLuminance(background)
    const foregroundLum = toLuminance(foreground)
    const ratio = (Math.max(backgroundLum, foregroundLum) + 0.05) /
      (Math.min(backgroundLum, foregroundLum) + 0.05)

    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('updatePreference("theme","dark") applies immediately AND caches to localStorage (no-flash on reload)', async () => {
    await useSettingsStore.getState().updatePreference('theme', 'dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const cached = JSON.parse(localStorage.getItem('grantflow:settings:v1') || '{}')
    expect(cached.theme).toBe('dark')
  })
})

describe('settingsStore — one-time migration from legacy context store', () => {
  it('seeds theme + accent from the old grantflow:dashboard-preferences:v1 on first load', async () => {
    localStorage.clear()
    localStorage.setItem(
      'grantflow:dashboard-preferences:v1',
      JSON.stringify({ darkMode: true, colorTheme: 'emerald', fontSize: 'large' }),
    )
    vi.resetModules()
    const mod = await import('@/stores/settingsStore')
    const prefs = mod.useSettingsStore.getState().preferences
    expect(prefs.theme).toBe('dark')
    expect(prefs.accent_color).toBe('emerald')
    expect(prefs.font_size).toBe('large')
  })
})
