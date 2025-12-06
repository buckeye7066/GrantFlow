import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Zap } from 'lucide-react';

/**
 * Dialog for alert configuration (placeholder for future settings)
 */
export default function AlertConfigDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Alert Configuration</DialogTitle>
          <DialogDescription>
            Configure which alerts you want to receive for your grants
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-slate-600 mb-4">
            Alert settings are per-organization. Select an organization above to configure its alerts.
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-blue-900">
              <Zap className="w-4 h-4 inline mr-1" />
              Coming soon: Configure alert preferences, notification methods, and thresholds for each organization.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}