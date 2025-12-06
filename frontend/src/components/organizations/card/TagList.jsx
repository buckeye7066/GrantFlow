import React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * Reusable tag list with "show more" badge
 * 
 * @param {Array} items - Array of tag strings to display
 * @param {number} limit - Maximum number to show before "show more"
 * @param {string} variant - Badge variant (default, secondary, outline)
 * @param {string} className - Additional classes for badges
 */
export default function TagList({ 
  items = [], 
  limit = 3, 
  variant = 'secondary',
  className = '' 
}) {
  if (!items || items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {items.slice(0, limit).map((item, index) => (
        <Badge 
          key={index} 
          variant={variant} 
          className={`text-xs ${className}`}
        >
          {item}
        </Badge>
      ))}
      {items.length > limit && (
        <Badge variant={variant} className={`text-xs ${className}`}>
          +{items.length - limit} more
        </Badge>
      )}
    </div>
  );
}