import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Search } from 'lucide-react';

/**
 * Dialog for searching for a specific source
 */
export default function AISearchDialog({ 
  open, 
  onOpenChange, 
  selectedOrg, 
  onSearch,
  isSearching 
}) {
  const [sourceName, setSourceName] = useState('');
  const [location, setLocation] = useState('');

  const handleSearch = () => {
    if (!sourceName.trim()) return;
    
    onSearch({
      source_name: sourceName,
      location: location || (selectedOrg ? `${selectedOrg.city}, ${selectedOrg.state}` : ''),
    });
  };

  const handleClose = () => {
    onOpenChange(false);
    setSourceName('');
    setLocation('');
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-emerald-600" />
            Search for Funding Source
          </DialogTitle>
          <DialogDescription>
            Enter a source name and AI will find all the details
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="source-name">Source Name *</Label>
            <Input
              id="source-name"
              placeholder="e.g., Cleveland Lions Club, Lee University"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSearching) {
                  handleSearch();
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="location">Location (Optional)</Label>
            <Input
              id="location"
              placeholder={selectedOrg ? `${selectedOrg.city}, ${selectedOrg.state}` : "e.g., Cleveland, TN"}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
            <p className="text-xs text-slate-500">
              Leave blank to use profile location ({selectedOrg?.city}, {selectedOrg?.state})
            </p>
          </div>

          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <p className="text-xs text-emerald-900">
              💡 AI will search the web to find:
            </p>
            <ul className="text-xs text-emerald-800 mt-2 space-y-1 ml-4">
              <li>• Official website and scholarship pages</li>
              <li>• Contact information (email, phone)</li>
              <li>• Typical award amounts</li>
              <li>• Eligibility requirements</li>
              <li>• How to apply</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button 
            variant="outline" 
            onClick={handleClose}
            disabled={isSearching}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSearch}
            disabled={!sourceName.trim() || isSearching}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {isSearching ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Search
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}