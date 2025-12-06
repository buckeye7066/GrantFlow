import React, { useState } from 'react';

/**
 * Profile image with fallback icon
 * Handles image loading errors gracefully
 */
export default function ProfileImage({ 
  imageUrl, 
  name, 
  Icon, 
  colorScheme 
}) {
  const [imgError, setImgError] = useState(false);

  // Reset error state when URL changes
  React.useEffect(() => {
    setImgError(false);
  }, [imageUrl]);

  if (imageUrl && !imgError) {
    return (
      <img 
        src={imageUrl} 
        alt={`${name} profile`}
        className="w-12 h-12 rounded-lg object-cover border border-slate-100"
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div className={`p-2.5 ${colorScheme.bg} rounded-lg group-hover:${colorScheme.bgHover} transition-colors`}>
      <Icon className={`w-5 h-5 ${colorScheme.icon}`} />
    </div>
  );
}