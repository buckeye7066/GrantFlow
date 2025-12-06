import React, { useState, useCallback, useEffect } from 'react';
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

// Modular filter components
import FilterSection from './filters/FilterSection';
import ActiveFilterBadges from './filters/ActiveFilterBadges';
import AmountRangeFilter from './filters/AmountRangeFilter';
import DateRangeFilter from './filters/DateRangeFilter';
import MatchScoreFilter from './filters/MatchScoreFilter';
import SavedFilterPresets from './filters/SavedFilterPresets';

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

/**
 * AdvancedFilters - Filter UI for grants/opportunities
 * @param {Object} props
 * @param {Object} props.filters - Current filter values
 * @param {Function} props.onFiltersChange - Callback when filters change
 * @param {Array} props.allTags - Available tags for filtering
 * @param {Array} props.savedPresets - Saved filter presets (optional)
 * @param {Function} props.onSavePreset - Handler to save preset (optional)
 * @param {Function} props.onDeletePreset - Handler to delete preset (optional)
 * @param {boolean} props.persistToUrl - Whether to persist filters to URL (optional)
 */
export default function AdvancedFilters({ 
  filters, 
  onFiltersChange, 
  allTags = [],
  availableTags, // FIXED: Accept both prop names for compatibility
  savedPresets = [],
  onSavePreset,
  onDeletePreset,
  persistToUrl = false
}) {
  // FIXED: Use availableTags if provided, fallback to allTags for backwards compat
  const tagsList = availableTags || allTags;
  const [localFilters, setLocalFilters] = useState(filters);
  const [isOpen, setIsOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(filters.search || '');

  // Debounced search to avoid rapid updates
  const debouncedSearch = useDebounce(searchInput, 300);

  // Apply debounced search to filters - FIXED: removed localFilters from deps to prevent infinite loop
  React.useEffect(() => {
    setLocalFilters(prev => {
      // Only update if search actually changed
      if (prev.search === debouncedSearch) return prev;
      const updated = { ...prev, search: debouncedSearch };
      onFiltersChange(updated);
      return updated;
    });
  }, [debouncedSearch, onFiltersChange]);

  // Sync external filter changes - FIXED: only sync when filters prop changes
  useEffect(() => {
    setLocalFilters(prev => {
      // Compare without search since we handle that separately
      const prevWithoutSearch = { ...prev, search: '' };
      const filtersWithoutSearch = { ...filters, search: '' };
      if (JSON.stringify(prevWithoutSearch) !== JSON.stringify(filtersWithoutSearch)) {
        setSearchInput(filters.search || '');
        return filters;
      }
      return prev;
    });
  }, [filters]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl/Cmd + K to focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        document.querySelector('input[aria-label="Search grants"]')?.focus();
      }
      // Ctrl/Cmd + Shift + F to open filters
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setIsOpen(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  /**
   * Handle applying filters (only called on button click)
   */
  const handleApply = useCallback(() => {
    onFiltersChange(localFilters);
    setIsOpen(false);
  }, [localFilters, onFiltersChange]);

  /**
   * Handle resetting all filters
   */
  const handleReset = useCallback(() => {
    const emptyFilters = {
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
    setLocalFilters(emptyFilters);
    setSearchInput('');
    onFiltersChange(emptyFilters);
    setIsOpen(false);
  }, [onFiltersChange]);

  /**
   * Remove individual filter
   */
  const handleRemoveFilter = useCallback((filterKey) => {
    const updated = { ...localFilters };
    
    if (filterKey === 'hideExpired' || filterKey === 'showOnlyExpired' || filterKey === 'keywordIncludesAllTerms') {
      updated[filterKey] = false;
    } else if (Array.isArray(updated[filterKey])) {
      updated[filterKey] = [];
    } else {
      // Handle cases where filterKey is part of a compound filter, like 'minAmount'
      updated[filterKey] = filterKey.includes('Amount') ? '' : filterKey === 'matchScoreMin' ? 0 : null;
    }
    
    setLocalFilters(updated);
    onFiltersChange(updated);
  }, [localFilters, onFiltersChange]);

  /**
   * Load saved preset
   */
  const handleLoadPreset = useCallback((presetFilters) => {
    setLocalFilters(presetFilters);
    setSearchInput(presetFilters.search || '');
    onFiltersChange(presetFilters);
    setIsOpen(false); // Close popover after loading preset
  }, [onFiltersChange]);

  /**
   * Count active filters
   */
  const activeFilterCount = Object.entries(localFilters).filter(([key, value]) => {
    // Exclude 'search' from the active filter count badge if it's handled separately
    if (key === 'search') return false; // Search input is visible, so don't count it towards the badge
    if (key === 'minAmount' || key === 'maxAmount') return value !== '';
    if (key === 'matchScoreMin') return value > 0;
    if (key === 'deadlineAfter' || key === 'deadlineBefore') return value !== null && value !== ''; // Check for null or empty string
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'boolean') return value === true;
    return false;
  }).length;

  const hasActiveFilters = activeFilterCount > 0 || (localFilters.search && localFilters.search.length > 0);

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
                        onCheckedChange={(checked) => setLocalFilters({ 
                          ...localFilters, 
                          hideExpired: checked,
                          showOnlyExpired: false 
                        })}
                      />
                      <Label htmlFor="hide-expired" className="text-sm font-normal cursor-pointer">
                        Hide expired deadlines
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="show-only-expired"
                        checked={localFilters.showOnlyExpired || false}
                        onCheckedChange={(checked) => setLocalFilters({ 
                          ...localFilters, 
                          showOnlyExpired: checked,
                          hideExpired: false 
                        })}
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
                      options={tagsList.map(tag => ({ value: tag, label: tag }))}
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
                    <p className="text-xs text-slate-500 mt-1">
                      Require all search terms to be present
                    </p>
                  </div>
                  <Switch
                    id="keyword-all"
                    checked={localFilters.keywordIncludesAllTerms || false}
                    onCheckedChange={(checked) => setLocalFilters({ 
                      ...localFilters, 
                      keywordIncludesAllTerms: checked 
                    })}
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
        <ActiveFilterBadges
          filters={localFilters}
          onRemoveFilter={handleRemoveFilter}
          onResetAll={handleReset}
        />
      )}
    </div>
  );
}