import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Play, ExternalLink, Edit, Trash2, ChevronDown, ChevronUp, Clock, Target } from 'lucide-react';
import OpportunityList from './OpportunityList';

/**
 * Main source directory table
 */
export default function SourceTable({
  filteredSources,
  selectedSources,
  onToggleSource,
  onToggleAll,
  onCrawl,
  onEdit,
  onDelete,
  crawlingInBackground,
  sourcesDue,
  expandedSourceId,
  onToggleExpand,
  sourceTypeFilter,
  onClearFilter,
  // For expanded row
  sourceOpportunities,
  isLoadingOpportunities,
  allGrants,
  selectedOrgId,
}) {
  return (
    <Card className="sources-table">
      <CardHeader>
        <CardTitle>Sources ({filteredSources.length})</CardTitle>
        {sourceTypeFilter !== 'all' && (
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
              Filtered: {sourceTypeFilter.replace(/_/g, ' ')}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearFilter}
              className="text-xs"
            >
              Clear filter
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={
                    selectedSources.length === filteredSources.length &&
                    filteredSources.length > 0
                  }
                  onCheckedChange={onToggleAll}
                />
              </TableHead>
              <TableHead className="w-12"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Last Crawled</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Opportunities</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSources.map((source) => {
              const isDue = sourcesDue.some((s) => s.id === source.id);
              const isCrawling = crawlingInBackground.includes(source.id);
              const isExpanded = expandedSourceId === source.id;

              return (
                <React.Fragment key={source.id}>
                  <TableRow className={isCrawling ? 'bg-amber-50' : ''}>
                    <TableCell>
                      <Checkbox
                        checked={selectedSources.includes(source.id)}
                        onCheckedChange={() => onToggleSource(source.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onToggleExpand(source.id)}
                        disabled={!source.opportunities_found || source.opportunities_found === 0}
                      >
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {source.name}
                        {isCrawling && (
                          <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
                            <Clock className="w-3 h-3 mr-1 animate-pulse" />
                            crawling...
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {source.source_type?.replace(/_/g, ' ') || 'N/A'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {source.city && source.state
                        ? `${source.city}, ${source.state}`
                        : source.state || 'N/A'}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {source.last_crawled ? (
                        <>
                          {new Date(source.last_crawled).toLocaleDateString()}
                          {isDue && (
                            <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200">
                              due
                            </Badge>
                          )}
                        </>
                      ) : (
                        <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                          never
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {source.crawl_frequency || 'monthly'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold text-slate-900">
                        {source.opportunities_found || 0}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          source.active
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }
                      >
                        {source.active ? 'active' : 'inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onCrawl(source.id)}
                          disabled={isCrawling}
                          title="Crawl this source"
                        >
                          {isCrawling ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                        </Button>
                        {source.website_url && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => window.open(source.website_url, '_blank')}
                            title="Visit website"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onEdit(source)}
                          title="Edit source"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDelete({ type: 'single', id: source.id })}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Delete source"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  
                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={10} className="bg-slate-50 p-4">
                        <OpportunityList
                          source={source}
                          opportunities={sourceOpportunities}
                          isLoading={isLoadingOpportunities}
                          allGrants={allGrants}
                          selectedOrgId={selectedOrgId}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>

        {filteredSources.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <Target className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p className="font-semibold">No sources found</p>
            <p className="text-sm mt-1">
              Try adjusting your filters or use AI Discovery to find sources
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}