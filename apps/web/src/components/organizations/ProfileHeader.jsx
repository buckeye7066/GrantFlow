import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, ImagePlus, Printer } from 'lucide-react';
import ProfileCustomizer from './ProfileCustomizer';

// Theme presets for styling
const THEME_STYLES = {
  default: { accent: '#2563eb', bg: '#f8fafc', text: '#1e293b' },
  ocean: { accent: '#0891b2', bg: '#ecfeff', text: '#164e63' },
  forest: { accent: '#059669', bg: '#ecfdf5', text: '#064e3b' },
  sunset: { accent: '#ea580c', bg: '#fff7ed', text: '#7c2d12' },
  lavender: { accent: '#7c3aed', bg: '#faf5ff', text: '#4c1d95' },
  midnight: { accent: '#6366f1', bg: '#1e1b4b', text: '#e0e7ff' },
  custom: { accent: '#2563eb', bg: '#ffffff', text: '#1e293b' },
};

const FONT_STYLES = {
  system: '',
  inter: 'font-sans',
  georgia: 'font-serif',
  comic: 'font-sans',
  roboto: 'font-sans',
};

/**
 * Profile header with image, name, and action buttons
 */
export default function ProfileHeader({
  organization,
  subtitle,
  totalGrantFunding,
  onBack,
  onDelete,
  onEmailComposer,
  onFindPicture,
  onPrint,
  onUpdate,
  hasEmails,
  isLoadingContacts,
  isFindingPicture,
  isUpdating,
}) {
  const [imgError, setImgError] = useState(false);

  // Reset image error when URL changes
  useEffect(() => {
    setImgError(false);
  }, [organization?.profile_image_url]);

  const showFindPictureButton = !organization?.profile_image_url || imgError;

  // Get theme styling
  const theme = organization?.profile_theme || 'default';
  const themeStyle = THEME_STYLES[theme] || THEME_STYLES.default;
  const accentColor = organization?.profile_accent_color || themeStyle.accent;
  const bgColor = organization?.profile_background_color || themeStyle.bg;
  const textColor = theme === 'midnight' ? '#e0e7ff' : themeStyle.text;
  const fontClass = FONT_STYLES[organization?.profile_font_family] || '';
  const bgImage = organization?.profile_background_image_url;

  return (
    <header 
      className={`p-6 border-b flex justify-between items-start printable-hidden ${fontClass}`}
      style={{
        backgroundColor: bgColor,
        backgroundImage: bgImage ? `linear-gradient(rgba(255,255,255,0.85), rgba(255,255,255,0.85)), url(${bgImage})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="flex items-start gap-6">
        {/* Profile Image */}
        <div className="relative group">
          {organization?.profile_image_url && !imgError ? (
            <img
              src={organization.profile_image_url}
              alt={organization.name}
              className="w-24 h-24 rounded-xl object-cover border-2 border-slate-100"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-24 h-24 rounded-xl bg-slate-100 flex items-center justify-center border-2 border-dashed">
              <ImagePlus className="w-8 h-8 text-slate-400" />
            </div>
          )}
          <div
            className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 flex items-center justify-center rounded-xl transition-opacity cursor-pointer"
            onClick={onFindPicture}
            role="button"
            tabIndex={0}
            aria-label="Upload profile picture"
          >
            <span className="text-white font-bold opacity-0 group-hover:opacity-100 transition-opacity text-sm">
              Upload
            </span>
          </div>
        </div>

        {/* Profile Info */}
        <div>
          <Button 
            variant="ghost" 
            onClick={onBack} 
            className="mb-2 -ml-3 h-auto p-2"
            aria-label="Back to organizations list"
          >
            &larr; Back to list
          </Button>
          <h1 
            className={`text-3xl font-bold ${fontClass}`}
            style={{ color: textColor }}
          >
            {organization?.name}
          </h1>
          <p 
            className="text-md mt-1"
            style={{ color: accentColor }}
          >
            {subtitle}
          </p>
          
          {showFindPictureButton && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onFindPicture}
              disabled={isFindingPicture || isUpdating}
            >
              {isFindingPicture ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Searching...</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-2" /> Find Picture with AI</>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-start gap-2 flex-wrap">
        <ProfileCustomizer 
          organization={organization}
          onUpdate={onUpdate}
          isUpdating={isUpdating}
        />
        <Button
          variant="outline"
          onClick={onEmailComposer}
          disabled={!hasEmails || isLoadingContacts}
          aria-label="Email for update"
        >
          <Sparkles className="w-4 h-4 mr-2" />
          Email for Update
        </Button>
        <Button variant="outline" onClick={onPrint} aria-label="Print profile">
          <Printer className="w-4 h-4 mr-2" />
          Print Profile
        </Button>
        {totalGrantFunding !== undefined && totalGrantFunding > 0 && (
          <div className="px-4 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border-2 border-blue-200">
            <div className="text-xs font-semibold text-blue-700 uppercase">Total Awarded</div>
            <div className="text-2xl font-bold text-blue-900">${totalGrantFunding.toLocaleString()}</div>
          </div>
        )}
        <Button variant="destructive" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </header>
  );
}