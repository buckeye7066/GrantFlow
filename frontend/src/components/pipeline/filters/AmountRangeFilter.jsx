import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

/**
 * AmountRangeFilter - Dual slider + input for funding amount range
 * @param {Object} props
 * @param {string|number} props.minAmount - Minimum amount value
 * @param {string|number} props.maxAmount - Maximum amount value
 * @param {Function} props.onMinChange - Handler for min change (expects event-like { target: { value } })
 * @param {Function} props.onMaxChange - Handler for max change (expects event-like { target: { value } })
 */
export default function AmountRangeFilter({
  minAmount,
  maxAmount,
  onMinChange,
  onMaxChange,
}) {
  // Slider range (0 to 1M in increments)
  const sliderMin = 0;
  const sliderMax = 1_000_000;
  const step = 10_000;

  // Safe int parse
  const toInt = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  };

  const clamp = (n) => Math.min(sliderMax, Math.max(sliderMin, n));

  // Parse current values for slider (do not mutate parents)
  const minParsed = clamp(toInt(minAmount, sliderMin));
  const maxParsed = clamp(toInt(maxAmount, sliderMax));

  // Ensure slider always sees [min <= max]
  const sliderVals =
    minParsed <= maxParsed ? [minParsed, maxParsed] : [maxParsed, minParsed];

  // Slider → emit event-like objects to keep parent signature unchanged
  const handleSliderChange = (values) => {
    if (!Array.isArray(values) || values.length < 2) return;
    const [a, b] = values;
    onMinChange({ target: { value: String(Math.min(a, b)) } });
    onMaxChange({ target: { value: String(Math.max(a, b)) } });
  };

  // Display helpers
  const hasAny = (minAmount !== '' && minAmount !== undefined && minAmount !== null) ||
                 (maxAmount !== '' && maxAmount !== undefined && maxAmount !== null);

  const fmtMoney = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : fallback;
  };

  // Keep controlled string values for inputs
  const minInputValue = minAmount ?? '';
  const maxInputValue = maxAmount ?? '';

  return (
    <div className="space-y-3">
      {/* Visual Slider */}
      <div className="px-2">
        <Slider
          min={sliderMin}
          max={sliderMax}
          step={step}
          value={sliderVals}
          onValueChange={handleSliderChange}
          className="w-full"
          aria-label="Funding amount range"
        />
      </div>

      {/* Numeric Inputs */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-slate-500">Min Amount</Label>
          <Input
            type="number"
            placeholder="$0"
            value={minInputValue}
            onChange={onMinChange}
            min={sliderMin}
            step={1000}
            className="h-9"
            inputMode="numeric"
            aria-label="Minimum amount"
          />
        </div>
        <div>
          <Label className="text-xs text-slate-500">Max Amount</Label>
          <Input
            type="number"
            placeholder="No max"
            value={maxInputValue}
            onChange={onMaxChange}
            min={sliderMin}
            step={1000}
            className="h-9"
            inputMode="numeric"
            aria-label="Maximum amount"
          />
        </div>
      </div>

      {/* Range Display */}
      <div className="text-xs text-center text-slate-500">
        {hasAny ? (
          <span>
            ${fmtMoney(minAmount, '0')} - ${fmtMoney(maxAmount, '∞')}
          </span>
        ) : (
          <span>Any amount</span>
        )}
      </div>
    </div>
  );
}