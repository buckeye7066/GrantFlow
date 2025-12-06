import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const PRESET_THEMES = [
  {
    id: 'daylight',
    label: 'Daylight',
    backgroundColor: '#f8fafc',
    overlay: 'radial-gradient(circle at 25% 20%, rgba(59,130,246,0.18) 0%, rgba(15,23,42,0) 55%)',
    textColor: '#0f172a',
    accentColor: '#2563eb',
    surfaceColor: 'rgba(255,255,255,0.88)',
    surfaceBorderColor: 'rgba(148,163,184,0.24)',
    surfaceShadow: '0 24px 50px rgba(15,23,42,0.12)',
    blurStrength: 18,
  },
  {
    id: 'midnight',
    label: 'Midnight',
    backgroundColor: '#0f172a',
    overlay: 'radial-gradient(circle at 15% 15%, rgba(56,189,248,0.28) 0%, rgba(15,23,42,0) 60%)',
    textColor: '#e2e8f0',
    accentColor: '#38bdf8',
    surfaceColor: 'rgba(15,23,42,0.82)',
    surfaceBorderColor: 'rgba(56,189,248,0.25)',
    surfaceShadow: '0 32px 60px rgba(8,11,27,0.55)',
    blurStrength: 26,
  },
  {
    id: 'aurora',
    label: 'Aurora',
    backgroundColor: '#0b1120',
    overlay: 'radial-gradient(circle at 70% 20%, rgba(168,85,247,0.32) 0%, rgba(15,23,42,0) 60%)',
    textColor: '#f1f5f9',
    accentColor: '#a855f7',
    surfaceColor: 'rgba(15,23,42,0.78)',
    surfaceBorderColor: 'rgba(168,85,247,0.3)',
    surfaceShadow: '0 30px 75px rgba(76,29,149,0.45)',
    blurStrength: 30,
  },
  {
    id: 'sunset',
    label: 'Sunset',
    backgroundColor: '#1f2937',
    overlay: 'radial-gradient(circle at 15% 75%, rgba(249,115,22,0.28) 0%, rgba(17,24,39,0) 60%)',
    textColor: '#f8fafc',
    accentColor: '#f97316',
    surfaceColor: 'rgba(17,24,39,0.82)',
    surfaceBorderColor: 'rgba(249,115,22,0.28)',
    surfaceShadow: '0 28px 65px rgba(8,11,27,0.45)',
    blurStrength: 24,
  },
];

const FONT_PRESETS = [
  { id: 'inter', label: 'Inter', stack: "'Inter', 'Segoe UI', system-ui, sans-serif" },
  { id: 'serif', label: 'Merriweather', stack: "'Merriweather', 'Georgia', serif" },
  { id: 'grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', 'Trebuchet MS', sans-serif" },
  { id: 'mono', label: 'JetBrains Mono', stack: "'JetBrains Mono', 'Fira Code', monospace" },
];

const LOCAL_STORAGE_KEY = 'base44-theme-settings';

const ThemeSettingsContext = createContext(null);

const hexToRgba = (hex, alpha) => {
  const clean = hex?.replace('#', '');
  if (!clean || (clean.length !== 3 && clean.length !== 6)) return `rgba(37, 99, 235, ${alpha})`;
  const normalized = clean.length === 3 ? clean.split('').map(ch => ch + ch).join('') : clean;
  const int = parseInt(normalized, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const isDark = (hex) => {
  const clean = hex?.replace('#', '');
  if (!clean || clean.length < 6) return false;
  const int = parseInt(clean.slice(0, 6), 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.55;
};

const readInitialSettings = () => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

export const ThemeSettingsProvider = ({ children }) => {
  const defaultPreset = PRESET_THEMES[0];
  const stored = readInitialSettings();
  const [settings, setSettings] = useState(() => ({
    ...defaultPreset,
    fontId: 'inter',
    overlayOpacity: 0.45,
    ...(stored ?? {}),
  }));

  const applyToDocument = useCallback((cfg) => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--base44-page-background', cfg.backgroundColor);
    root.style.setProperty('--base44-page-foreground', cfg.textColor);
    root.style.setProperty('--base44-background-overlay', cfg.overlay || 'none');
    root.style.setProperty('--base44-overlay-opacity', String(cfg.overlayOpacity ?? 0.45));
    root.style.setProperty('--base44-surface', cfg.surfaceColor);
    root.style.setProperty('--base44-surface-border', cfg.surfaceBorderColor);
    root.style.setProperty('--base44-shadow-soft', cfg.surfaceShadow || '0 18px 45px rgba(15,23,42,0.12)');
    root.style.setProperty('--base44-accent-color', cfg.accentColor);
    root.style.setProperty('--base44-accent-soft', hexToRgba(cfg.accentColor, 0.18));
    root.style.setProperty('--base44-accent-strong', hexToRgba(cfg.accentColor, 0.32));
    root.style.setProperty('--base44-blur-strength', `${cfg.blurStrength || 18}px`);
    const font = FONT_PRESETS.find(f => f.id === cfg.fontId) ?? FONT_PRESETS[0];
    root.style.setProperty('--base44-font-family', font.stack);
    root.style.setProperty('--base44-heading-color', isDark(cfg.backgroundColor) ? '#f8fafc' : '#0f172a');
    document.body.dataset.theme = cfg.themeId || 'custom';
  }, []);

  useEffect(() => {
    applyToDocument(settings);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
    }
  }, [applyToDocument, settings]);

  const updateSetting = useCallback((partial) => {
    setSettings(prev => ({ ...prev, ...partial }));
  }, []);

  const applyPreset = useCallback((presetId) => {
    const preset = PRESET_THEMES.find(t => t.id === presetId);
    if (!preset) return;
    setSettings(prev => ({ ...preset, themeId: preset.id, fontId: prev.fontId, overlayOpacity: preset.overlayOpacity ?? prev.overlayOpacity ?? 0.45 }));
  }, []);

  const resetTheme = useCallback(() => {
    const preset = PRESET_THEMES[0];
    setSettings({ ...preset, fontId: 'inter', overlayOpacity: preset.overlayOpacity ?? 0.45 });
  }, []);

  const value = useMemo(() => ({
    settings,
    presets: PRESET_THEMES,
    fonts: FONT_PRESETS,
    accentColor: settings.accentColor,
    updateSetting,
    applyPreset,
    resetTheme,
    themeClasses: {
      surface: 'theme-surface',
      elevated: 'theme-elevated-surface',
      subtle: 'theme-surface-subtle',
      accentText: 'theme-accent-text',
      accentBg: 'theme-accent-bg',
    },
  }), [settings, applyPreset, updateSetting, resetTheme]);

  return (
    <ThemeSettingsContext.Provider value={value}>
      {children}
    </ThemeSettingsContext.Provider>
  );
};

export const useThemeSettings = () => {
  const ctx = useContext(ThemeSettingsContext);
  if (!ctx) {
    // Return safe defaults if used outside provider
    return {
      settings: {},
      presets: [],
      fonts: [],
      accentColor: '#2563eb',
      updateSetting: () => {},
      applyPreset: () => {},
      resetTheme: () => {},
      themeClasses: {
        surface: '',
        elevated: '',
        subtle: '',
        accentText: '',
        accentBg: '',
      },
    };
  }
  return ctx;
};