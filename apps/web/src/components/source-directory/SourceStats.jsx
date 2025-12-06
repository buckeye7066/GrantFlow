import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Target, CheckCircle, TrendingUp, Trash2, Brain, ExternalLink, Loader2, X } from 'lucide-react';

/**
 * Statistics cards for source directory - now clickable with drill-down dialogs
 */
export default function SourceStats({ 
  relevantSources, 
  sourcesDue, 
  onDeleteSources,
  onDiscoverMore,
  isDeleting,
  isDiscovering,
  selectedOrg
}) {
  const [openDialog, setOpenDialog] = useState(null); // 'all' | 'active' | 'due'
  const [selectedForDelete, setSelectedForDelete] = useState([]);
  
  const activeCount = relevantSources.filter(s => s.active).length;
  const activeSources = relevantSources.filter(s => s.active);

  const getDialogSources = () => {
    switch (openDialog) {
      case 'all': return relevantSources;
      case 'active': return activeSources;
      case 'due': return sourcesDue;
      default: return [];
    }
  };

  const getDialogTitle = () => {
    switch (openDialog) {
      case 'all': return `All Sources (${relevantSources.length})`;
      case 'active': return `Active Sources (${activeCount})`;
      case 'due': return `Sources Due for Crawl (${sourcesDue.length})`;
      default: return '';
    }
  };

  const handleToggleSelect = (sourceId) => {
    setSelectedForDelete(prev => 
      prev.includes(sourceId) 
        ? prev.filter(id => id !== sourceId)
        : [...prev, sourceId]
    );
  };

  const handleSelectAll = () => {
    const sources = getDialogSources();
    if (selectedForDelete.length === sources.length) {
      setSelectedForDelete([]);
    } else {
      setSelectedForDelete(sources.map(s => s.id));
    }
  };

  const handleDelete = () => {
    if (selectedForDelete.length > 0 && onDeleteSources) {
      onDeleteSources(selectedForDelete);
      setSelectedForDelete([]);
    }
  };

  const handleCloseDialog = () => {
    setOpenDialog(null);
    setSelectedForDelete([]);
  };

  const dialogSources = getDialogSources();

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card 
          className="cursor-pointer hover:shadow-lg hover:border-blue-300 transition-all"
          onClick={() => setOpenDialog('all')}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-500">Sources for This Profile</div>
                <div className="text-3xl font-bold text-slate-900 mt-1">
                  {relevantSources.length}
                </div>
                <div className="text-xs text-blue-600 mt-1">Click to view & manage</div>
              </div>
              <Target className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card 
          className="cursor-pointer hover:shadow-lg hover:border-emerald-300 transition-all"
          onClick={() => setOpenDialog('active')}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-500">Active Sources</div>
                <div className="text-3xl font-bold text-emerald-600 mt-1">
                  {activeCount}
                </div>
                <div className="text-xs text-emerald-600 mt-1">Click to view & manage</div>
              </div>
              <CheckCircle className="w-10 h-10 text-emerald-500 opacity-50" />
            </div>
          </CardContent>
        </Card>

        <Card 
          className="cursor-pointer hover:shadow-lg hover:border-amber-300 transition-all"
          onClick={() => setOpenDialog('due')}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-500">Due for Crawl</div>
                <div className="text-3xl font-bold text-amber-600 mt-1">
                  {sourcesDue.length}
                </div>
                <div className="text-xs text-amber-600 mt-1">Click to view & manage</div>
              </div>
              <TrendingUp className="w-10 h-10 text-amber-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Source List Dialog */}
      <Dialog open={!!openDialog} onOpenChange={(open) => !open && handleCloseDialog()}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>{getDialogTitle()}</span>
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto">
            {dialogSources.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Target className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p>No sources found in this category.</p>
                <Button 
                  onClick={() => {
                    handleCloseDialog();
                    onDiscoverMore?.();
                  }}
                  className="mt-4 bg-purple-600 hover:bg-purple-700"
                >
                  <Brain className="w-4 h-4 mr-2" />
                  AI Discover Sources
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4 pb-2 border-b">
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      checked={selectedForDelete.length === dialogSources.length && dialogSources.length > 0}
                      onCheckedChange={handleSelectAll}
                    />
                    <span className="text-sm text-slate-600">
                      {selectedForDelete.length > 0 
                        ? `${selectedForDelete.length} selected` 
                        : 'Select all'}
                    </span>
                  </div>
                  {selectedForDelete.length > 0 && (
                    <Button 
                      variant="destructive" 
                      size="sm"
                      onClick={handleDelete}
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4 mr-2" />
                      )}
                      Delete {selectedForDelete.length}
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                  {dialogSources.map((source) => (
                    <div 
                      key={source.id} 
                      className="flex items-center gap-3 p-3 border rounded-lg hover:bg-slate-50"
                    >
                      <Checkbox 
                        checked={selectedForDelete.includes(source.id)}
                        onCheckedChange={() => handleToggleSelect(source.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-900 truncate">
                            {source.name}
                          </span>
                          <Badge variant="outline" className="capitalize text-xs">
                            {source.source_type?.replace(/_/g, ' ')}
                          </Badge>
                          {source.active ? (
                            <Badge className="bg-emerald-50 text-emerald-700 text-xs">Active</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">Inactive</Badge>
                          )}
                        </div>
                        <div className="text-sm text-slate-500 truncate">
                          {source.city && source.state 
                            ? `${source.city}, ${source.state}` 
                            : source.state || 'No location'}
                        </div>
                      </div>
                      {source.website_url && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(source.website_url, '_blank');
                          }}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="border-t pt-4">
            <Button variant="outline" onClick={handleCloseDialog}>
              Close
            </Button>
            <Button 
              onClick={() => {
                handleCloseDialog();
                onDiscoverMore?.();
              }}
              className="bg-purple-600 hover:bg-purple-700"
              disabled={isDiscovering}
            >
              {isDiscovering ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Brain className="w-4 h-4 mr-2" />
              )}
              AI Find More Sources
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}