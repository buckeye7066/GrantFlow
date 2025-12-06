import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { Palette, Type, Image, Sparkles, Upload, Loader2, X } from 'lucide-react';

const THEME_PRESETS = {
  default: {
    name: 'Default',
    accent: '#2563eb',
    background: '#f8fafc',
    preview: 'bg-gradient-to-r from-blue-500 to-blue-600'
  },
  ocean: {
    name: 'Ocean',
    accent: '#0891b2',
    background: '#ecfeff',
    preview: 'bg-gradient-to-r from-cyan-500 to-teal-500'
  },
  forest: {
    name: 'Forest',
    accent: '#059669',
    background: '#ecfdf5',
    preview: 'bg-gradient-to-r from-emerald-500 to-green-600'
  },
  sunset: {
    name: 'Sunset',
    accent: '#ea580c',
    background: '#fff7ed',
    preview: 'bg-gradient-to-r from-orange-500 to-red-500'
  },
  lavender: {
    name: 'Lavender',
    accent: '#7c3aed',
    background: '#faf5ff',
    preview: 'bg-gradient-to-r from-violet-500 to-purple-600'
  },
  midnight: {
    name: 'Midnight',
    accent: '#6366f1',
    background: '#1e1b4b',
    preview: 'bg-gradient-to-r from-indigo-600 to-slate-800'
  },
  custom: {
    name: 'Custom',
    accent: '#2563eb',
    background: '#ffffff',
    preview: 'bg-gradient-to-r from-gray-400 to-gray-500'
  }
};

const FONT_OPTIONS = [
  { value: 'system', label: 'System Default', style: 'font-sans' },
  { value: 'inter', label: 'Inter (Modern)', style: 'font-sans' },
  { value: 'georgia', label: 'Georgia (Classic)', style: 'font-serif' },
  { value: 'comic', label: 'Comic Sans (Fun)', style: 'font-sans' },
  { value: 'roboto', label: 'Roboto (Clean)', style: 'font-sans' },
];

export default function ProfileCustomizer({ organization, onUpdate, isUpdating }) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const [localSettings, setLocalSettings] = useState({
    profile_theme: organization?.profile_theme || 'default',
    profile_accent_color: organization?.profile_accent_color || THEME_PRESETS.default.accent,
    profile_background_color: organization?.profile_background_color || THEME_PRESETS.default.background,
    profile_font_family: organization?.profile_font_family || 'system',
    profile_background_image_url: organization?.profile_background_image_url || '',
    profile_image_url: organization?.profile_image_url || '',
  });

  const handleThemeChange = (theme) => {
    const preset = THEME_PRESETS[theme];
    setLocalSettings(prev => ({
      ...prev,
      profile_theme: theme,
      profile_accent_color: theme === 'custom' ? prev.profile_accent_color : preset.accent,
      profile_background_color: theme === 'custom' ? prev.profile_background_color : preset.background,
    }));
  };

  const handleImageUpload = async (e, field) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        variant: 'destructive',
        title: 'Invalid File',
        description: 'Please select an image file.',
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        variant: 'destructive',
        title: 'File Too Large',
        description: 'Please select an image under 5MB.',
      });
      return;
    }

    setIsUploading(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      const url = result?.file_url;
      
      if (url) {
        setLocalSettings(prev => ({ ...prev, [field]: url }));
        toast({
          title: 'Image Uploaded',
          description: 'Your image has been uploaded successfully.',
        });
      }
    } catch (err) {
      console.error('[ProfileCustomizer] Upload error:', err);
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: err?.message || 'Could not upload image.',
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = () => {
    if (!organization?.id) return;
    
    onUpdate({
      id: organization.id,
      data: localSettings
    });
    
    setIsOpen(false);
    toast({
      title: 'Profile Customized',
      description: 'Your personalization settings have been saved.',
    });
  };

  const handleClearImage = (field) => {
    setLocalSettings(prev => ({ ...prev, [field]: '' }));
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Palette className="w-4 h-4" />
          Personalize
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <Card className="border-0 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-500" />
              Personalize Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Theme Presets */}
            <div>
              <Label className="text-sm font-medium mb-2 block">Color Theme</Label>
              <div className="grid grid-cols-4 gap-2">
                {Object.entries(THEME_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleThemeChange(key)}
                    className={`h-12 rounded-lg ${preset.preview} ${
                      localSettings.profile_theme === key 
                        ? 'ring-2 ring-offset-2 ring-blue-500' 
                        : 'hover:opacity-80'
                    } transition-all`}
                    title={preset.name}
                  />
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Selected: {THEME_PRESETS[localSettings.profile_theme]?.name || 'Default'}
              </p>
            </div>

            {/* Custom Colors (only show when custom theme selected) */}
            {localSettings.profile_theme === 'custom' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Accent Color</Label>
                  <div className="flex gap-2 mt-1">
                    <input
                      type="color"
                      value={localSettings.profile_accent_color}
                      onChange={(e) => setLocalSettings(prev => ({ 
                        ...prev, 
                        profile_accent_color: e.target.value 
                      }))}
                      className="w-10 h-8 rounded cursor-pointer border"
                    />
                    <Input
                      value={localSettings.profile_accent_color}
                      onChange={(e) => setLocalSettings(prev => ({ 
                        ...prev, 
                        profile_accent_color: e.target.value 
                      }))}
                      className="flex-1 h-8 text-xs"
                      placeholder="#2563eb"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Background</Label>
                  <div className="flex gap-2 mt-1">
                    <input
                      type="color"
                      value={localSettings.profile_background_color}
                      onChange={(e) => setLocalSettings(prev => ({ 
                        ...prev, 
                        profile_background_color: e.target.value 
                      }))}
                      className="w-10 h-8 rounded cursor-pointer border"
                    />
                    <Input
                      value={localSettings.profile_background_color}
                      onChange={(e) => setLocalSettings(prev => ({ 
                        ...prev, 
                        profile_background_color: e.target.value 
                      }))}
                      className="flex-1 h-8 text-xs"
                      placeholder="#f8fafc"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Font Family */}
            <div>
              <Label className="text-sm font-medium mb-2 flex items-center gap-2">
                <Type className="w-4 h-4" />
                Font Style
              </Label>
              <Select
                value={localSettings.profile_font_family}
                onValueChange={(value) => setLocalSettings(prev => ({ 
                  ...prev, 
                  profile_font_family: value 
                }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_OPTIONS.map(font => (
                    <SelectItem key={font.value} value={font.value} className={font.style}>
                      {font.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Profile Picture (for individuals without website) */}
            <div>
              <Label className="text-sm font-medium mb-2 flex items-center gap-2">
                <Image className="w-4 h-4" />
                Profile Picture
              </Label>
              {localSettings.profile_image_url ? (
                <div className="relative inline-block">
                  <img
                    src={localSettings.profile_image_url}
                    alt="Profile"
                    className="w-20 h-20 rounded-full object-cover border-2 border-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => handleClearImage('profile_image_url')}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <label className="flex items-center justify-center w-20 h-20 border-2 border-dashed border-slate-300 rounded-full cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImageUpload(e, 'profile_image_url')}
                    className="hidden"
                    disabled={isUploading}
                  />
                  {isUploading ? (
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  ) : (
                    <Upload className="w-6 h-6 text-slate-400" />
                  )}
                </label>
              )}
              <p className="text-xs text-slate-500 mt-1">Upload your photo</p>
            </div>

            {/* Background Image */}
            <div>
              <Label className="text-sm font-medium mb-2 flex items-center gap-2">
                <Image className="w-4 h-4" />
                Background Image (Optional)
              </Label>
              {localSettings.profile_background_image_url ? (
                <div className="relative">
                  <img
                    src={localSettings.profile_background_image_url}
                    alt="Background"
                    className="w-full h-20 rounded-lg object-cover border"
                  />
                  <button
                    type="button"
                    onClick={() => handleClearImage('profile_background_image_url')}
                    className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <label className="flex items-center justify-center w-full h-16 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImageUpload(e, 'profile_background_image_url')}
                    className="hidden"
                    disabled={isUploading}
                  />
                  {isUploading ? (
                    <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                  ) : (
                    <div className="text-center">
                      <Upload className="w-5 h-5 text-slate-400 mx-auto" />
                      <span className="text-xs text-slate-500">Upload background</span>
                    </div>
                  )}
                </label>
              )}
            </div>

            {/* Preview */}
            <div 
              className="p-4 rounded-lg border"
              style={{
                backgroundColor: localSettings.profile_background_color,
                backgroundImage: localSettings.profile_background_image_url 
                  ? `url(${localSettings.profile_background_image_url})` 
                  : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              <div className="flex items-center gap-3">
                {localSettings.profile_image_url ? (
                  <img 
                    src={localSettings.profile_image_url} 
                    alt="Preview" 
                    className="w-10 h-10 rounded-full object-cover border-2 border-white shadow"
                  />
                ) : (
                  <div 
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shadow"
                    style={{ backgroundColor: localSettings.profile_accent_color }}
                  >
                    {organization?.name?.[0] || 'P'}
                  </div>
                )}
                <div>
                  <p 
                    className="font-semibold text-sm"
                    style={{ 
                      color: localSettings.profile_theme === 'midnight' ? '#fff' : '#1e293b',
                      fontFamily: localSettings.profile_font_family === 'georgia' ? 'Georgia, serif' : 'inherit'
                    }}
                  >
                    {organization?.name || 'Profile Name'}
                  </p>
                  <p 
                    className="text-xs"
                    style={{ color: localSettings.profile_accent_color }}
                  >
                    Preview
                  </p>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setIsOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="flex-1"
                onClick={handleSave}
                disabled={isUpdating}
              >
                {isUpdating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </PopoverContent>
    </Popover>
  );
}