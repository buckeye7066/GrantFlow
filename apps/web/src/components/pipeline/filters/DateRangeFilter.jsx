import React from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, X } from 'lucide-react';
import { format } from 'date-fns';

/**
 * Safely parse an ISO string to Date, returning undefined on invalid.
 */
const safeParse = (iso) => {
  if (!iso || typeof iso !== 'string') return undefined;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
};

/**
 * Serialize a Date to ISO safely with a noon-time anchor to reduce TZ off-by-one
 * when the consumer treats the string as a date-only value.
 */
const toAnchoredISO = (d) => {
  if (!d) return null;
  const copy = new Date(d.getTime());
  // Anchor to local noon to mitigate timezone date-shift when re-parsed
  copy.setHours(12, 0, 0, 0);
  return copy.toISOString();
};

/**
 * DateRangeFilter - Date range picker for deadlines
 * @param {Object} props
 * @param {string} props.deadlineAfter - After date (ISO string)
 * @param {string} props.deadlineBefore - Before date (ISO string)
 * @param {Function} props.onAfterChange - Handler for after date
 * @param {Function} props.onBeforeChange - Handler for before date
 */
export default function DateRangeFilter({
  deadlineAfter,
  deadlineBefore,
  onAfterChange,
  onBeforeChange,
}) {
  const afterDate = safeParse(deadlineAfter);
  const beforeDate = safeParse(deadlineBefore);

  return (
    <div className="space-y-2">
      {/* After Date */}
      <div>
        <label className="text-xs text-slate-500 block mb-1">Deadline After</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={`w-full justify-start text-left font-normal h-9 ${
                !afterDate && 'text-slate-500'
              }`}
              aria-label="Pick deadline after date"
            >
              <CalendarIcon className="mr-2 h-4 w-4" aria-hidden="true" />
              {afterDate ? format(afterDate, 'MMM d, yyyy') : 'Select date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={afterDate}
              onSelect={(date) => onAfterChange(toAnchoredISO(date || null))}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        {afterDate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAfterChange(null)}
            className="mt-1 h-6 text-xs"
            aria-label="Clear deadline after"
          >
            <X className="w-3 h-3 mr-1" aria-hidden="true" />
            Clear
          </Button>
        )}
      </div>

      {/* Before Date */}
      <div>
        <label className="text-xs text-slate-500 block mb-1">Deadline Before</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={`w-full justify-start text-left font-normal h-9 ${
                !beforeDate && 'text-slate-500'
              }`}
              aria-label="Pick deadline before date"
            >
              <CalendarIcon className="mr-2 h-4 w-4" aria-hidden="true" />
              {beforeDate ? format(beforeDate, 'MMM d, yyyy') : 'Select date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={beforeDate}
              onSelect={(date) => onBeforeChange(toAnchoredISO(date || null))}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        {beforeDate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onBeforeChange(null)}
            className="mt-1 h-6 text-xs"
            aria-label="Clear deadline before"
          >
            <X className="w-3 h-3 mr-1" aria-hidden="true" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}