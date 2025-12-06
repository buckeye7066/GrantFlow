import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Play, Trash2, Sparkles, Zap, Plus, Filter, Search as SearchIcon } from 'lucide-react';

/**
 * Toolbar with search, filters, and actions
 */
export default function SourceToolbar({
  searchQuery,
  onSearchChange,
  sourceTypeFilter,
  onTypeFilterChange,
  sourceTypes,
  selectedSources,
  sourcesDue,
  onBulkCrawl,
  onBulkDelete,
  onCrawlAllDue,
  onOpenDiscover,
  onOpenSearch,
  onOpenAdd,
}) {
  return (
    <div className="flex flex-col gap-4 mb-6">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search sources..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={sourceTypeFilter} onValueChange={onTypeFilterChange}>
          <SelectTrigger className="w-full md:w-48">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4" />
              <SelectValue placeholder="Filter by type..." />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {sourceTypes.map(type => (
              <SelectItem key={type} value={type}>
                {type.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-2 flex-wrap">
        {selectedSources.length > 0 && (
          <>
            <Button
              onClick={onBulkCrawl}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Play className="w-4 h-4 mr-2" />
              Crawl {selectedSources.length} Selected
            </Button>
            <Button
              onClick={onBulkDelete}
              variant="destructive"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete {selectedSources.length} Selected
            </Button>
          </>
        )}

        {sourcesDue.length > 0 && (
          <Button
            onClick={onCrawlAllDue}
            variant="outline"
            className="border-amber-500 text-amber-600 hover:bg-amber-50"
          >
            <Zap className="w-4 h-4 mr-2" />
            Crawl {sourcesDue.length} Due
          </Button>
        )}

        <Button
          variant="outline"
          onClick={onOpenDiscover}
        >
          <Sparkles className="w-4 h-4 mr-2" />
          AI Discover More
        </Button>

        <Button
          variant="outline"
          onClick={onOpenSearch}
          className="border-emerald-500 text-emerald-600 hover:bg-emerald-50"
        >
          <SearchIcon className="w-4 h-4 mr-2" />
          Search for Source
        </Button>

        <Button onClick={onOpenAdd}>
          <Plus className="w-4 h-4 mr-2" />
          Add Source
        </Button>
      </div>
    </div>
  );
}