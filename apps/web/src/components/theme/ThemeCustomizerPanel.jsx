import React, { useState } from 'react';
import { useThemeSettings } from './ThemeSettingsProvider';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Palette, RotateCcw, Check } from 'lucide-react';

export default function ThemeCustomizerPanel() {
  const {
    settings,
    presets,
    fonts,
    updateSetting,
    applyPreset,
    resetTheme,
  } = useThemeSettings();

  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-slate-600 hover:bg-slate-100"
          title="Customize Theme"
        >
          <Palette className="w-5 h-5" />
        </Button>
      </SheetTrigger>
      <SheetContent className="w-80 overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Palette className="w-5 h-5" />
            Theme Settings
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Preset Themes */}
          <div>
            <Label className="text-sm font-medium mb-3 block">Preset Themes</Label>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset.id)}
                  className={`relative p-3 rounded-lg border-2 transition-all ${
                    settings.themeId === preset.id || settings.id === preset.id
                      ? 'border-blue-500 ring-2 ring-blue-200'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                  style={{ backgroundColor: preset.backgroundColor }}
                >
                  <div
                    className="w-full h-6 rounded mb-2"
                    style={{ backgroundColor: preset.accentColor }}
                  />
                  <span
                    className="text-xs font-medium"
                    style={{ color: preset.textColor }}
                  >
                    {preset.label}
                  </span>
                  {(settings.themeId === preset.id || settings.id === preset.id) && (
                    <div className="absolute top-1 right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Accent Color */}
          <div>
            <Label className="text-sm font-medium mb-2 block">Accent Color</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={settings.accentColor || '#2563eb'}
                onChange={(e) => updateSetting({ accentColor: e.target.value, themeId: 'custom' })}
                className="theme-color-input w-12 h-10 cursor-pointer rounded-lg border border-slate-200"
              />
              <span className="text-sm text-slate-600 font-mono">
                {settings.accentColor || '#2563eb'}
              </span>
            </div>
          </div>

          {/* Font Selection */}
          <div>
            <Label className="text-sm font-medium mb-3 block">Font</Label>
            <div className="space-y-2">
              {fonts.map((font) => (
                <button
                  key={font.id}
                  onClick={() => updateSetting({ fontId: font.id })}
                  className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                    settings.fontId === font.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                  style={{ fontFamily: font.stack }}
                >
                  <span className="text-sm font-medium">{font.label}</span>
                  <span className="block text-xs text-slate-500 mt-1">
                    The quick brown fox jumps...
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Blur Strength */}
          <div>
            <Label className="text-sm font-medium mb-2 block">
              Blur Strength: {settings.blurStrength || 18}px
            </Label>
            <Slider
              value={[settings.blurStrength || 18]}
              onValueChange={([val]) => updateSetting({ blurStrength: val, themeId: 'custom' })}
              min={0}
              max={40}
              step={2}
              className="mt-2"
            />
          </div>

          {/* Overlay Opacity */}
          <div>
            <Label className="text-sm font-medium mb-2 block">
              Overlay Opacity: {Math.round((settings.overlayOpacity || 0.45) * 100)}%
            </Label>
            <Slider
              value={[(settings.overlayOpacity || 0.45) * 100]}
              onValueChange={([val]) => updateSetting({ overlayOpacity: val / 100, themeId: 'custom' })}
              min={0}
              max={100}
              step={5}
              className="mt-2"
            />
          </div>

          {/* Reset Button */}
          <Button
            variant="outline"
            onClick={resetTheme}
            className="w-full mt-4"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset to Default
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}