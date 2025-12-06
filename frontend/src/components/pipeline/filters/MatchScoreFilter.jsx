import React from 'react';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Minus, Plus } from 'lucide-react';

/**
 * MatchScoreFilter - Slider for minimum match percentage
 * @param {Object} props
 * @param {number|string} props.matchScoreMin - Minimum match score (0-100)
 * @param {Function} props.onChange - Handler for value change (number)
 * @param {Array} props.marks - Optional labeled tick marks [{value, label}]
 * @param {boolean} props.showAdjustButtons - Show ±5% keyboard buttons
 */
export default function MatchScoreFilter({ 
  matchScoreMin = 0, 
  onChange,
  marks,
  showAdjustButtons = false 
}) {
  // Coerce and clamp to [0,100], integer
  const raw = Number(matchScoreMin);
  const safeScore = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;

  const handleChange = (values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const v = Number(values[0]);
    if (!Number.isFinite(v)) return;
    // Clamp before emitting
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    onChange(clamped);
  };

  const handleIncrement = (delta) => {
    const newVal = Math.max(0, Math.min(100, safeScore + delta));
    onChange(newVal);
  };

  const getScoreColor = (score) => {
    if (score >= 80) return 'bg-emerald-500 text-white';
    if (score >= 65) return 'bg-green-500 text-white';
    if (score >= 50) return 'bg-blue-500 text-white';
    if (score >= 35) return 'bg-amber-500 text-white';
    return 'bg-slate-400 text-white';
  };

  // Normalize marks to array with valid entries
  const safeMarks = Array.isArray(marks)
    ? marks.filter((m) => m && typeof m.value === 'number')
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Minimum Match Score</Label>
        <div className="flex items-center gap-1">
          {showAdjustButtons && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleIncrement(-5)}
              disabled={safeScore <= 0}
              aria-label="Decrease by 5%"
            >
              <Minus className="w-3 h-3" aria-hidden="true" />
            </Button>
          )}
          <Badge className={`text-xs font-bold ${getScoreColor(safeScore)}`}>
            {safeScore}%
          </Badge>
          {showAdjustButtons && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleIncrement(5)}
              disabled={safeScore >= 100}
              aria-label="Increase by 5%"
            >
              <Plus className="w-3 h-3" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <Slider
        min={0}
        max={100}
        step={5}
        value={[safeScore]}
        onValueChange={handleChange}
        className="w-full"
        aria-label="Minimum match score"
      />

      {safeMarks ? (
        <div className="flex justify-between text-xs text-slate-500">
          {safeMarks.map((m, idx) => (
            <span key={`mark-${m.value}-${idx}`}>{m.label ?? `${m.value}%`}</span>
          ))}
        </div>
      ) : (
        <div className="flex justify-between text-xs text-slate-500">
          <span>0% (Any)</span>
          <span>50%</span>
          <span>100%</span>
        </div>
      )}

      {safeScore > 0 && (
        <p className="text-xs text-slate-600">
          Only show opportunities with {safeScore}% or higher match
        </p>
      )}
    </div>
  );
}