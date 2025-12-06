import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';

/**
 * Dialog for AI source discovery
 */
export default function AIDiscoverDialog({ 
  open, 
  onOpenChange, 
  selectedOrg, 
  onDiscover 
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            AI Source Discovery
          </DialogTitle>
          <DialogDescription>
            Discover more funding sources for {selectedOrg?.name}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <p className="text-sm text-slate-600 mb-4">
            AI will search for universities, service clubs, foundations, and other local organizations
            that offer funding in <strong>{selectedOrg?.city && selectedOrg?.state ? `${selectedOrg.city}, ${selectedOrg.state}` : selectedOrg?.state || 'your area'}</strong>.
          </p>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-900">
              💡 Discovery will run in the background (2-3 minutes). You can continue working!
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onDiscover}>
            <Sparkles className="w-4 h-4 mr-2" />
            Start Discovery
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}