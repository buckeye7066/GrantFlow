import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { X, RotateCcw } from 'lucide-react';

const safeMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : null;
};

const safeDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

export default function ActiveFilterBadges({ filters, onRemoveFilter, onResetAll }) {
  const badges = [];

  // Deadline status badges
  if (filters.hideExpired) {
    badges.push({ key: 'hideExpired', label: 'Hide Expired', variant: 'secondary' });
  }
  if (filters.showOnlyExpired) {
    badges.push({ key: 'showOnlyExpired', label: 'Only Expired', variant: 'destructive' });
  }

  // Amount badges
  const minFmt = safeMoney(filters.minAmount);
  if (minFmt) {
    badges.push({ key: 'minAmount', label: `Min: $${minFmt}`, variant: 'secondary' });
  }
  const maxFmt = safeMoney(filters.maxAmount);
  if (maxFmt) {
    badges.push({ key: 'maxAmount', label: `Max: $${maxFmt}`, variant: 'secondary' });
  }

  // Match score badge
  const score = Number(filters.matchScoreMin);
  if (Number.isFinite(score) && score > 0) {
    badges.push({ key: 'matchScoreMin', label: `Match ≥ ${Math.round(score)}%`, variant: 'secondary' });
  }

  // Date range badges
  const after = safeDate(filters.deadlineAfter);
  if (after) {
    badges.push({ key: 'deadlineAfter', label: `After ${after}`, variant: 'secondary' });
  }
  const before = safeDate(filters.deadlineBefore);
  if (before) {
    badges.push({ key: 'deadlineBefore', label: `Before ${before}`, variant: 'secondary' });
  }

  // Multi-select badges
  const len = (arr) => (Array.isArray(arr) ? arr.length : 0);
  const funderLen = len(filters.funderTypes);
  if (funderLen > 0) {
    badges.push({ key: 'funderTypes', label: `${funderLen} Funder Type${funderLen > 1 ? 's' : ''}`, variant: 'secondary' });
  }
  const appLen = len(filters.applicationMethods);
  if (appLen > 0) {
    badges.push({ key: 'applicationMethods', label: `${appLen} App Method${appLen > 1 ? 's' : ''}`, variant: 'secondary' });
  }
  const oppLen = len(filters.opportunityTypes);
  if (oppLen > 0) {
    badges.push({ key: 'opportunityTypes', label: `${oppLen} Opp Type${oppLen > 1 ? 's' : ''}`, variant: 'secondary' });
  }
  const tagsLen = len(filters.tags);
  if (tagsLen > 0) {
    badges.push({ key: 'tags', label: `${tagsLen} Tag${tagsLen > 1 ? 's' : ''}`, variant: 'secondary' });
  }

  // Keyword toggle
  if (filters.keywordIncludesAllTerms) {
    badges.push({ key: 'keywordIncludesAllTerms', label: 'Match All Keywords', variant: 'secondary' });
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-slate-500 font-medium">Active filters:</span>

      {badges.map((badge) => (
        <Badge key={`flt-${String(badge.key)}`} variant={badge.variant} className="gap-1">
          {badge.label}
          <X
            className="w-3 h-3 cursor-pointer hover:text-red-600"
            onClick={() => onRemoveFilter(badge.key)}
            aria-label={`Remove filter ${badge.label}`}
            role="button"
          />
        </Badge>
      ))}

      <Button
        variant="ghost"
        size="sm"
        onClick={onResetAll}
        className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
      >
        <RotateCcw className="w-3 h-3 mr-1" />
        Reset All
      </Button>
    </div>
  );
}