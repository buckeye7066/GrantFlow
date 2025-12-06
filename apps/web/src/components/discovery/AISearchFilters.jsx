import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Sparkles, X, Plus } from 'lucide-react';

export default function AISearchFilters({ filters, onChange, onApply }) {
  const [localFilters, setLocalFilters] = useState(filters || {
    keywords: [],
    minAmount: 0,
    maxAmount: 1000000,
    minMatchScore: 60,
    includeExpired: false,
    focusAreas: [],
    opportunityTypes: ['grant', 'scholarship'],
    requiresApplication: true,
  });

  const [keywordInput, setKeywordInput] = useState('');
  const [focusAreaInput, setFocusAreaInput] = useState('');

  const addKeyword = () => {
    if (keywordInput.trim() && !localFilters.keywords.includes(keywordInput.trim())) {
      const updated = {
        ...localFilters,
        keywords: [...localFilters.keywords, keywordInput.trim()]
      };
      setLocalFilters(updated);
      onChange?.(updated);
      setKeywordInput('');
    }
  };

  const removeKeyword = (keyword) => {
    const updated = {
      ...localFilters,
      keywords: localFilters.keywords.filter(k => k !== keyword)
    };
    setLocalFilters(updated);
    onChange?.(updated);
  };

  const addFocusArea = () => {
    if (focusAreaInput.trim() && !localFilters.focusAreas.includes(focusAreaInput.trim())) {
      const updated = {
        ...localFilters,
        focusAreas: [...localFilters.focusAreas, focusAreaInput.trim()]
      };
      setLocalFilters(updated);
      onChange?.(updated);
      setFocusAreaInput('');
    }
  };

  const removeFocusArea = (area) => {
    const updated = {
      ...localFilters,
      focusAreas: localFilters.focusAreas.filter(a => a !== area)
    };
    setLocalFilters(updated);
    onChange?.(updated);
  };

  const toggleOpportunityType = (type) => {
    const updated = {
      ...localFilters,
      opportunityTypes: localFilters.opportunityTypes.includes(type)
        ? localFilters.opportunityTypes.filter(t => t !== type)
        : [...localFilters.opportunityTypes, type]
    };
    setLocalFilters(updated);
    onChange?.(updated);
  };

  const updateFilter = (key, value) => {
    const updated = { ...localFilters, [key]: value };
    setLocalFilters(updated);
    onChange?.(updated);
  };

  return (
    <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-blue-900">
          <Sparkles className="w-5 h-5" />
          AI-Powered Filters
        </CardTitle>
        <CardDescription>
          Refine your search with intelligent filtering
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Keywords */}
        <div>
          <Label className="text-sm font-semibold mb-2 block">Keywords & Topics</Label>
          <div className="flex gap-2 mb-2">
            <Input
              placeholder="Add keyword..."
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
              className="flex-1"
            />
            <Button onClick={addKeyword} size="sm" variant="outline">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {localFilters.keywords.map((keyword) => (
              <Badge key={keyword} variant="secondary" className="gap-1">
                {keyword}
                <X 
                  className="w-3 h-3 cursor-pointer" 
                  onClick={() => removeKeyword(keyword)}
                />
              </Badge>
            ))}
          </div>
        </div>

        {/* Focus Areas */}
        <div>
          <Label className="text-sm font-semibold mb-2 block">Focus Areas</Label>
          <div className="flex gap-2 mb-2">
            <Input
              placeholder="e.g., Education, Healthcare..."
              value={focusAreaInput}
              onChange={(e) => setFocusAreaInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFocusArea()}
              className="flex-1"
            />
            <Button onClick={addFocusArea} size="sm" variant="outline">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {localFilters.focusAreas.map((area) => (
              <Badge key={area} variant="secondary" className="gap-1 bg-purple-100 text-purple-700">
                {area}
                <X 
                  className="w-3 h-3 cursor-pointer" 
                  onClick={() => removeFocusArea(area)}
                />
              </Badge>
            ))}
          </div>
        </div>

        {/* Award Amount Range */}
        <div>
          <Label className="text-sm font-semibold mb-2 block">
            Award Amount: ${localFilters.minAmount.toLocaleString()} - ${localFilters.maxAmount.toLocaleString()}
          </Label>
          <div className="space-y-2">
            <Input
              type="number"
              placeholder="Min amount"
              value={localFilters.minAmount}
              onChange={(e) => updateFilter('minAmount', parseInt(e.target.value) || 0)}
              className="w-full"
            />
            <Input
              type="number"
              placeholder="Max amount"
              value={localFilters.maxAmount}
              onChange={(e) => updateFilter('maxAmount', parseInt(e.target.value) || 1000000)}
              className="w-full"
            />
          </div>
        </div>

        {/* Minimum Match Score */}
        <div>
          <Label className="text-sm font-semibold mb-2 block">
            Minimum Match Score: {localFilters.minMatchScore}%
          </Label>
          <Slider
            value={[localFilters.minMatchScore]}
            onValueChange={(value) => updateFilter('minMatchScore', value[0])}
            min={0}
            max={100}
            step={5}
            className="w-full"
          />
          <p className="text-xs text-slate-600 mt-1">
            Only show opportunities with match score above this threshold
          </p>
        </div>

        {/* Opportunity Types */}
        <div>
          <Label className="text-sm font-semibold mb-2 block">Opportunity Types</Label>
          <div className="flex flex-wrap gap-2">
            {['grant', 'scholarship', 'fellowship', 'assistance', 'prize'].map((type) => (
              <Badge
                key={type}
                variant={localFilters.opportunityTypes.includes(type) ? 'default' : 'outline'}
                className="cursor-pointer capitalize"
                onClick={() => toggleOpportunityType(type)}
              >
                {type}
              </Badge>
            ))}
          </div>
        </div>

        {/* Include Expired */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-semibold">Include Expired Opportunities</Label>
            <p className="text-xs text-slate-600">Show opportunities past their deadline</p>
          </div>
          <Switch
            checked={localFilters.includeExpired}
            onCheckedChange={(checked) => updateFilter('includeExpired', checked)}
          />
        </div>

        {/* Requires Application */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-semibold">Requires Application</Label>
            <p className="text-xs text-slate-600">Only show opportunities that need applications</p>
          </div>
          <Switch
            checked={localFilters.requiresApplication}
            onCheckedChange={(checked) => updateFilter('requiresApplication', checked)}
          />
        </div>

        <Button 
          onClick={() => onApply?.(localFilters)} 
          className="w-full bg-blue-600 hover:bg-blue-700"
        >
          Apply Filters
        </Button>
      </CardContent>
    </Card>
  );
}