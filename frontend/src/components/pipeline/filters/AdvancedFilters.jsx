import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Search, SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import MultiSelectCombobox from '@/components/shared/MultiSelectCombobox';
import { useDebounce } from '@/components/hooks/useDebounce';

import FilterSection from './FilterSection';
import ActiveFilterBadges from './ActiveFilterBadges';
import AmountRangeFilter from './AmountRangeFilter';
import DateRangeFilter from './DateRangeFilter';
import MatchScoreFilter from './MatchScoreFilter';
import SavedFilterPresets from './SavedFilterPresets';

const FUNDER_TYPES = [
  { value: 'federal', label: 'Federal' },
  { value: 'state', label: 'State' },
  { value: 'local', label: 'Local Government' },
  { value: 'foundation', label: 'Foundation' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'university', label: 'University' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'medical', label: 'Medical' },
  { value: 'community', label: 'Community' },
  { value: 'other', label: 'Other' },
];

const APPLICATION_METHODS = [
  { value: 'standard', label: 'Standard Application' },
  { value: 'auto_fafsa', label: 'Auto via FAFSA' },
  { value: 'auto_profile', label: 'Auto Profile Match' },
  { value: 'nomination', label: 'Nomination Required' },
  { value: 'invitation', label: 'Invitation Only' },
  { value: 'no_application', label: 'No Application' },
];

const OPPORTUNITY_TYPES = [
  { value: 'grant', label: 'Grant' },
  { value: 'scholarship', label: 'Scholarship' },
  { value: 'fellowship', label: 'Fellowship' },
  { value: 'financial_assistance', label: 'Financial Assistance' },
  { value: 'prize', label: 'Prize' },
  { value: 'award', label: 'Award' },
  { value: 'other', label: 'Other' },
];

const DEFAULT_FILTERS = {
  search: '',
  minAmount: '',
  maxAmount: '',
  matchScoreMin: 0,
  deadlineAfter: null,
  deadlineBefore: null,
  funderTypes: [],
  applicationMethods: [],
  opportunityTypes: [],
  tags: [],
  hideExpired: false,
  showOnlyExpired: false,
  keywordIncludesAllTerms: false,
};

const serialize = (filters) => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'boolean') {
      if (v) params.set(k, '1');
    } else if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(','));
    } else if (typeof v === 'number') {
      if (v > 0) params.set(k, String(v));
    } else if (typeof v === 'string') {
      if (v.trim() !== '') params.set(k, v.trim());
    }
  });
  return params;
};

const deserialize = (params) => {
  const getArr = (key) => {
    const val = params.get(key);
    return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
  };
  const num = (key, def = 0) => {
    const v = Number(params.get(key));
    return Number.isFinite(v) ? v : def;
  };
  return {
    search: params.get('search') || '',
    minAmount: params.get('minAmount') || '',
    maxAmount: params.get('maxAmount') || '',
    matchScoreMin: num('matchScoreMin', 0),
    deadlineAfter: params.get('deadlineAfter'),
    deadlineBefore: params.get('deadlineBefore'),
    funderTypes: getArr('funderTypes'),
    applicationMethods: getArr('applicationMethods'),
    opportunityTypes: getArr('opportunityTypes'),
    tags: getArr('tags'),
    hideExpired: params.get('hideExpired') === '1',
    showOnlyExpired: params.get('showOnlyExpired') === '1',
    keywordIncludesAllTerms: params.get('keywordIncludesAllTerms') === '1',
  };
};

export default function AdvancedFilters({
  filters,
  onFiltersChange,
  allTags = [],
  availableTags,
  savedPresets = [],
  onSavePreset,
  onDeletePreset,
  persistToUrl = false,
}) {
  const tagsList = useMemo(
    () => (Array.isArray(availableTags) && availableTags.length > 0 ? availableTags : (Array.isArray(allTags) ? allTags : [])),
    [availableTags, allTags]
  );

  // If URL persistence is enabled, seed from URL once on mount
  const seededFromUrl = React.useRef(false);
  useEffect(() => {
    if (!persistToUrl || seededFromUrl.current) return;
    try {
      const url = new URL(window.location.href);
      const params = url.searchParams;
      const incoming = deserialize(params);
      // If any param is present, seed the filters
      if ([...params.keys()].some(Boolean)) {
        onFiltersChange({ ...DEFAULT_FILTERS, ...filters, ...incoming });
      }
    } catch {
      // ignore bad URLs
    } finally {
      seededFromUrl.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistToUrl]);

  const [localFilters, setLocalFilters] = useState(filters);
  const [isOpen, setIsOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(filters.search || '');

  // Debounced search to avoid rapid updates
  const debouncedSearch = useDebounce(searchInput, 300);

  // Apply debounced search to filters
  React.useEffect(() => {
    setLocalFilters(prev => {
      const nextSearch = debouncedSearch ?? '';
      if (prev.search === nextSearch) return prev;
      const updated = { ...prev, search: nextSearch };
      onFiltersChange(updated);
      return updated;
    });
  }, [debouncedSearch, onFiltersChange]);

  // Sync external filter changes
  useEffect(() => {
    setLocalFilters(prev => {
      const prevWithoutSearch = { ...prev, search: '' };
      const filtersWithoutSearch = { ...filters, search: '' };
      if (JSON.stringify(prevWithoutSearch) !== JSON.stringify(filtersWithoutSearch)) {
        setSearchInput(filters.search || '');
        return filters;
      }
      return prev;
    });
  }, [filters]);

  // URL persistence: push state on filter changes (debounced by search effect)
  useEffect(() => {
    if (!persistToUrl) return;
    try {
      const params = serialize(localFilters);
      const url = new URL(window.location.href);
      // Only push if changed
      const current = url.searchParams.toString();
      const next = params.toString();
      if (current !== next) {
        url.search = next;
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // ignore
    }
  }, [persistToUrl, localFilters]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl/Cmd + K to focus search
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector('input[aria-label="Search grants"]')?.focus();
      }
      // Ctrl/Cmd + Shift + F to open filters
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsOpen(true);
      }
      // Escape to close
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleApply = useCallback(() => {
    onFiltersChange(localFilters);
    setIsOpen(false);
  }, [localFilters, onFiltersChange]);

  const handleReset = useCallback(() => {
    const emptyFilters = { ...DEFAULT_FILTERS };
    setLocalFilters(emptyFilters);
    setSearchInput('');
    onFiltersChange(emptyFilters);
    setIsOpen(false);
  }, [onFiltersChange]);

  const handleRemoveFilter = useCallback((filterKey) => {
    const updated = { ...localFilters };

    if (filterKey === 'hideExpired' || filterKey === 'showOnlyExpired' || filterKey === 'keywordIncludesAllTerms') {
      updated[filterKey] = false;
    } else if (Array.isArray(updated[filterKey])) {
      updated[filterKey] = [];
    } else if (filterKey === 'matchScoreMin') {
      updated[filterKey] = 0;
    } else if (filterKey === 'minAmount' || filterKey === 'maxAmount') {
      updated[filterKey] = '';
    } else {
      updated[filterKey] = null;
    }

    setLocalFilters(updated);
    onFiltersChange(updated);
  }, [localFilters, onFiltersChange]);

  const handleLoadPreset = useCallback((presetFilters) => {
    const next = { ...DEFAULT_FILTERS, ...presetFilters };
    setLocalFilters(next);
    setSearchInput(next.search || '');
    onFiltersChange(next);
    setIsOpen(false);
  }, [onFiltersChange]);

  const activeFilterCount = useMemo(() => {
    return Object.entries(localFilters).filter(([key, value]) => {
      if (key === 'search') return false;
      if (key === 'minAmount' || key === 'maxAmount') return value !== '';
      if (key === 'matchScoreMin') return Number(value) > 0;
      if (key === 'deadlineAfter' || key === 'deadlineBefore') return value !== null && value !== '';
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'boolean') return value === true;
      return false;
    }).length;
  }, [localFilters]);

  const hasActiveFilters = activeFilterCount > 0 || !!(localFilters.search && localFilters.search.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        {/* Search Input with Debounce */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search grants (⌘K)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
            aria-label="Search grants"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="search"
          />
        </div>

        {/* Advanced Filters Popover */}
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="gap-2">
              <SlidersHorizontal className="w-4 h-4" />
              Advanced Filters
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="ml-1 px-2 py-0.5 text-xs">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[420px] max-h-[600px] overflow-y-auto" align="end">
            <Card className="border-0 shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Advanced Filters</CardTitle>
                <p className="text-xs text-slate-500">Use ⌘⇧F to open filters</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Deadline Status */}
                <FilterSection label="Deadline Status">
                  <div className="space-y-3">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="hide-expired"
                        checked={localFilters.hideExpired || false}
                        onCheckedChange={(checked) =>
                          setLocalFilters({
                            ...localFilters,
                            hideExpired: !!checked,
                            showOnlyExpired: false,
                          })
                        }
                      />
                      <Label htmlFor="hide-expired" className="text-sm font-normal cursor-pointer">
                        Hide expired deadlines
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="show-only-expired"
                        checked={localFilters.showOnlyExpired || false}
                        onCheckedChange={(checked) =>
                          setLocalFilters({
                            ...localFilters,
                            showOnlyExpired: !!checked,
                            hideExpired: false,
                          })
                        }
                      />
                      <Label htmlFor="show-only-expired" className="text-sm font-normal cursor-pointer">
                        Show only expired deadlines
                      </Label>
                    </div>
                  </div>
                </FilterSection>

                {/* Deadline Date Range */}
                <FilterSection label="Deadline Date Range" className="border-t pt-4">
                  <DateRangeFilter
                    deadlineAfter={localFilters.deadlineAfter}
                    deadlineBefore={localFilters.deadlineBefore}
                    onAfterChange={(date) => setLocalFilters({ ...localFilters, deadlineAfter: date })}
                    onBeforeChange={(date) => setLocalFilters({ ...localFilters, deadlineBefore: date })}
                  />
                </FilterSection>

                {/* Match Score Minimum */}
                <FilterSection label="Match Quality" className="border-t pt-4">
                  <MatchScoreFilter
                    matchScoreMin={localFilters.matchScoreMin || 0}
                    onChange={(value) => setLocalFilters({ ...localFilters, matchScoreMin: value })}
                  />
                </FilterSection>

                {/* Funding Amount Range */}
                <FilterSection label="Funding Amount Range" className="border-t pt-4">
                  <AmountRangeFilter
                    minAmount={localFilters.minAmount}
                    maxAmount={localFilters.maxAmount}
                    onMinChange={(e) => setLocalFilters({ ...localFilters, minAmount: e.target.value })}
                    onMaxChange={(e) => setLocalFilters({ ...localFilters, maxAmount: e.target.value })}
                  />
                </FilterSection>

                {/* Funder Types */}
                <FilterSection label="Funder Type" className="border-t pt-4">
                  <MultiSelectCombobox
                    options={FUNDER_TYPES}
                    selected={localFilters.funderTypes || []}
                    onSelectedChange={(selected) => setLocalFilters({ ...localFilters, funderTypes: selected })}
                    placeholder="Select funder types..."
                  />
                </FilterSection>

                {/* Application Methods */}
                <FilterSection label="Application Method" className="border-t pt-4">
                  <MultiSelectCombobox
                    options={APPLICATION_METHODS}
                    selected={localFilters.applicationMethods || []}
                    onSelectedChange={(selected) => setLocalFilters({ ...localFilters, applicationMethods: selected })}
                    placeholder="Select application methods..."
                  />
                </FilterSection>

                {/* Opportunity Types */}
                <FilterSection label="Opportunity Type" className="border-t pt-4">
                  <MultiSelectCombobox
                    options={OPPORTUNITY_TYPES}
                    selected={localFilters.opportunityTypes || []}
                    onSelectedChange={(selected) => setLocalFilters({ ...localFilters, opportunityTypes: selected })}
                    placeholder="Select opportunity types..."
                  />
                </FilterSection>

                {/* Tags */}
                {tagsList.length > 0 && (
                  <FilterSection label="Tags" className="border-t pt-4">
                    <MultiSelectCombobox
                      options={tagsList.map((tag) => ({ value: tag, label: tag }))}
                      selected={localFilters.tags || []}
                      onSelectedChange={(selected) => setLocalFilters({ ...localFilters, tags: selected })}
                      placeholder="Select tags..."
                    />
                  </FilterSection>
                )}

                {/* Keyword Matching Toggle */}
                <div className="flex items-center justify-between space-x-2 border-t pt-4">
                  <div className="flex-1">
                    <Label htmlFor="keyword-all" className="text-sm font-semibold">
                      Match All Keywords
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">Require all search terms to be present</p>
                  </div>
                  <Switch
                    id="keyword-all"
                    checked={localFilters.keywordIncludesAllTerms || false}
                    onCheckedChange={(checked) =>
                      setLocalFilters({
                        ...localFilters,
                        keywordIncludesAllTerms: !!checked,
                      })
                    }
                  />
                </div>

                {/* Apply/Cancel Buttons */}
                <div className="flex gap-2 pt-4 border-t">
                  <Button onClick={handleApply} className="flex-1">
                    Apply Filters
                  </Button>
                  <Button variant="outline" onClick={() => setIsOpen(false)} className="flex-1">
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          </PopoverContent>
        </Popover>

        {/* Saved Filter Presets */}
        {onSavePreset && onDeletePreset && (
          <SavedFilterPresets
            currentFilters={localFilters}
            onLoadPreset={handleLoadPreset}
            presets={savedPresets}
            onSavePreset={onSavePreset}
            onDeletePreset={onDeletePreset}
          />
        )}
      </div>

      {/* Active Filters Display */}
      {hasActiveFilters && (
        <ActiveFilterBadges filters={localFilters} onRemoveFilter={handleRemoveFilter} onResetAll={handleReset} />
      )}
    </div>
  );
}