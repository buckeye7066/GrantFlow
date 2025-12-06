import React from 'react';
import { CheckSquare } from 'lucide-react';
import { truncateText } from '@/components/shared/grantCardUtils';

/**
 * GrantEligibilityBullets - Display eligibility requirements
 * @param {Object} props
 * @param {string[]} props.bullets - Eligibility bullet points
 * @param {boolean} props.show - Whether to show eligibility
 */
export default function GrantEligibilityBullets({ bullets, show }) {
  if (!show || !Array.isArray(bullets)) return null;

  // Normalize: coerce to strings, trim, drop empties
  const normalized = bullets
    .map((b) => (typeof b === 'string' ? b : String(b ?? '')).trim())
    .filter((b) => b.length > 0);

  // Optional: remove consecutive duplicates
  const cleaned = [];
  for (const b of normalized) {
    if (cleaned.length === 0 || cleaned[cleaned.length - 1] !== b) cleaned.push(b);
  }

  if (cleaned.length === 0) return null;

  const topTwo = cleaned.slice(0, 2);
  const extraCount = Math.max(0, cleaned.length - 2);

  return (
    <div className="mt-2 space-y-1">
      {topTwo.map((bullet, idx) => (
        <div key={`${idx}-${bullet.slice(0, 20)}`} className="flex items-start gap-1">
          <CheckSquare
            className="w-3 h-3 text-emerald-600 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span className="text-xs text-slate-600 leading-tight">
            {truncateText(bullet, 100)}
          </span>
        </div>
      ))}
      {extraCount > 0 && (
        <span className="text-xs text-slate-500 italic block ml-4">
          +{extraCount} more requirements
        </span>
      )}
    </div>
  );
}