import React from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-react';

/**
 * Confirmation dialog for source deletion
 */
export default function DeleteConfirmDialog({ 
  open, 
  onOpenChange, 
  deleteTarget, 
  sourcesByType,
  onConfirm,
  isDeleting 
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteTarget?.type === 'single' && (
              <>Are you sure you want to delete this source? This action cannot be undone and will also delete related opportunities and grants for this organization.</>
            )}
            {deleteTarget?.type === 'bulk' && (
              <>Are you sure you want to delete {deleteTarget.ids?.length} selected sources? This action cannot be undone and will also delete related opportunities and grants for this organization.</>
            )}
            {deleteTarget?.type === 'by_source_type' && (
              <>
                Are you sure you want to delete all <strong>{deleteTarget.sourceType?.replace(/_/g, ' ')}</strong> sources
                ({sourcesByType[deleteTarget.sourceType]?.length} total)? This action cannot be undone and will also delete related opportunities and grants for this organization.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700"
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}