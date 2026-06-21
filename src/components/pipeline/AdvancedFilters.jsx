import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { X, Search, SlidersHorizontal, RotateCcw } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import MultiSelectCombobox from '@/components/shared/MultiSelectCombobox';

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

export default function AdvancedFilters({ filters, onFiltersChange, allTags = [] }) {
  const [localFilters, setLocalFilters] = useState(filters);
  const [isOpen, setIsOpen] = useState(false);

  const handleApply = () => {
    onFiltersChange(localFilters);
    setIsOpen(false);
  };

  const handleReset = () => {
    const emptyFilters = {
      search: '',
      minAmount: '',
      maxAmount: '',
      funderTypes: [],
      applicationMethods: [],
      opportunityTypes: [],
      tags: [],
      hideExpired: false,
      showOnlyExpired: false,
    };
    setLocalFilters(emptyFilters);
    onFiltersChange(emptyFilters);
    setIsOpen(false);
  };

  const activeFilterCount = Object.entries(localFilters).filter(([key, value]) => {
    if (key === 'search') return value.length > 0;
    if (key === 'minAmount' || key === 'maxAmount') return value !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'boolean') return value === true;
    return false;
  }).length;

  const hasActiveFilters = activeFilterCount > 0;

  return (
    <div className="flex gap-2 items-center flex-wrap">
      {/* Search Input */}
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          placeholder="Search grants by title, funder, or keywords..."
          value={localFilters.search}
          onChange={(e) => {
            const updated = { ...localFilters, search: e.target.value };
            setLocalFilters(updated);
            onFiltersChange(updated);
          }}
          className="pl-10"
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
        <PopoverContent className="w-96 max-h-[600px] overflow-y-auto" align="end">
          <Card className="border-0 shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="font-display text-lg text-current-ink">Advanced Filters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Deadline Status */}
              <div className="space-y-3 pb-3 border-b">
                <Label className="text-sm font-semibold">Deadline Status</Label>
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

              {/* Funding Amount Range */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Funding Amount Range</Label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-slate-500">Min Amount</Label>
                    <Input
                      type="number"
                      placeholder="$0"
                      value={localFilters.minAmount}
                      onChange={(e) => setLocalFilters({ ...localFilters, minAmount: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500">Max Amount</Label>
                    <Input
                      type="number"
                      placeholder="No max"
                      value={localFilters.maxAmount}
                      onChange={(e) => setLocalFilters({ ...localFilters, maxAmount: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              {/* Funder Types - FIXED */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Funder Type</Label>
                <MultiSelectCombobox
                  options={FUNDER_TYPES}
                  selected={localFilters.funderTypes || []}
                  onSelectedChange={(selected) => setLocalFilters({ ...localFilters, funderTypes: selected })}
                  placeholder="Select funder types..."
                />
              </div>

              {/* Application Methods - FIXED */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Application Method</Label>
                <MultiSelectCombobox
                  options={APPLICATION_METHODS}
                  selected={localFilters.applicationMethods || []}
                  onSelectedChange={(selected) => setLocalFilters({ ...localFilters, applicationMethods: selected })}
                  placeholder="Select application methods..."
                />
              </div>

              {/* Opportunity Types - FIXED */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Opportunity Type</Label>
                <MultiSelectCombobox
                  options={OPPORTUNITY_TYPES}
                  selected={localFilters.opportunityTypes || []}
                  onSelectedChange={(selected) => setLocalFilters({ ...localFilters, opportunityTypes: selected })}
                  placeholder="Select opportunity types..."
                />
              </div>

              {/* Tags - FIXED */}
              {allTags.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Tags</Label>
                  <MultiSelectCombobox
                    options={allTags.map(tag => ({ value: tag, label: tag }))}
                    selected={localFilters.tags || []}
                    onSelectedChange={(selected) => setLocalFilters({ ...localFilters, tags: selected })}
                    placeholder="Select tags..."
                  />
                </div>
              )}

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

      {/* Active Filters Display with Reset Button */}
      {hasActiveFilters && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="money text-xs font-bold uppercase tracking-[0.08em] text-current-ink/55">Active filters:</span>
          
          {localFilters.hideExpired && (
            <Badge variant="secondary" className="gap-1">
              Hide Expired
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, hideExpired: false };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}

          {localFilters.showOnlyExpired && (
            <Badge variant="secondary" className="gap-1 bg-red-100 text-red-800">
              Only Expired
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, showOnlyExpired: false };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.minAmount && (
            <Badge variant="secondary" className="gap-1">
              Min: ${parseInt(localFilters.minAmount).toLocaleString()}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, minAmount: '' };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.maxAmount && (
            <Badge variant="secondary" className="gap-1">
              Max: ${parseInt(localFilters.maxAmount).toLocaleString()}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, maxAmount: '' };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.funderTypes?.length > 0 && (
            <Badge variant="secondary" className="gap-1">
              {localFilters.funderTypes.length} Funder Type{localFilters.funderTypes.length > 1 ? 's' : ''}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, funderTypes: [] };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.applicationMethods?.length > 0 && (
            <Badge variant="secondary" className="gap-1">
              {localFilters.applicationMethods.length} App Method{localFilters.applicationMethods.length > 1 ? 's' : ''}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, applicationMethods: [] };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.opportunityTypes?.length > 0 && (
            <Badge variant="secondary" className="gap-1">
              {localFilters.opportunityTypes.length} Opp Type{localFilters.opportunityTypes.length > 1 ? 's' : ''}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, opportunityTypes: [] };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}
          
          {localFilters.tags?.length > 0 && (
            <Badge variant="secondary" className="gap-1">
              {localFilters.tags.length} Tag{localFilters.tags.length > 1 ? 's' : ''}
              <X
                className="w-3 h-3 cursor-pointer hover:text-red-600"
                onClick={() => {
                  const updated = { ...localFilters, tags: [] };
                  setLocalFilters(updated);
                  onFiltersChange(updated);
                }}
              />
            </Badge>
          )}

          {/* Prominent Reset All Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset All
          </Button>
        </div>
      )}
    </div>
  );
}