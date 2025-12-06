import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Kanban, Printer, Search, Loader2, TrendingUp, DollarSign } from 'lucide-react';
import { Card } from '@/components/ui/card';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import KanbanBoard from '@/components/pipeline/KanbanBoard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from "@/components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// number coercion helper
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pipeline tab - displays kanban board for grants
 */
export default function PipelineTab({
  grants,
  organization,
  isLoading,
  onGrantUpdate,
  organizationId,
}) {
  const [grantToDelete, setGrantToDelete] = useState(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['grants'] });
    if (organizationId) {
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
    }
  };

  const deleteGrantMutation = useMutation({
    mutationFn: (id) => base44.entities.Grant.delete(id),
    onSuccess: () => {
      invalidate();
      setGrantToDelete(null);
      toast({
        title: "Grant Deleted",
        description: "The grant has been successfully removed from your pipeline.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error?.message || "There was an error deleting the grant.",
      });
      setGrantToDelete(null);
    }
  });

  const handleDeleteGrant = () => {
    if (grantToDelete?.id) {
      deleteGrantMutation.mutate(grantToDelete.id);
    }
  };

  const safeGrants = Array.isArray(grants) ? grants : [];

  // Calculate funding statistics
  const fundingStats = useMemo(() => {
    const awardedGrants = safeGrants.filter(g => g.status === 'awarded');
    const totalAwarded = awardedGrants.reduce((sum, g) => {
      const amount = toNum(g.award_ceiling) || toNum(g.award_floor);
      return sum + amount;
    }, 0);

    // Breakdown by funder
    const funderBreakdown = {};
    awardedGrants.forEach(grant => {
      const funderName = grant.funder || 'Unknown Funder';
      const amount = toNum(grant.award_ceiling) || toNum(grant.award_floor);
      funderBreakdown[funderName] = (funderBreakdown[funderName] || 0) + amount;
    });

    return {
      totalAwarded,
      awardedCount: awardedGrants.length,
      funderBreakdown,
    };
  }, [safeGrants]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="mt-4 print:hidden">
      {/* Funding Summary */}
      {fundingStats.totalAwarded > 0 && (
        <Card className="p-6 mb-6 bg-gradient-to-r from-emerald-50 to-blue-50 border-2 border-emerald-200">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-5 h-5 text-emerald-600" />
                <h3 className="text-lg font-semibold text-slate-900">Total Awarded Funding</h3>
              </div>
              <div className="text-4xl font-bold text-emerald-700 mb-4">
                ${fundingStats.totalAwarded.toLocaleString()}
              </div>
              <p className="text-sm text-slate-600 mb-3">
                From {fundingStats.awardedCount} awarded grant{fundingStats.awardedCount !== 1 ? 's' : ''}
              </p>

              {Object.keys(fundingStats.funderBreakdown).length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-700 uppercase">Breakdown by Funder:</p>
                  {Object.entries(fundingStats.funderBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([funder, amount]) => (
                      <div key={funder} className="flex items-center justify-between text-sm bg-white/60 px-3 py-2 rounded-lg">
                        <span className="text-slate-700 font-medium truncate max-w-[300px]" title={funder}>
                          {funder}
                        </span>
                        <span className="font-bold text-emerald-700 ml-4">
                          ${amount.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  {Object.keys(fundingStats.funderBreakdown).length > 5 && (
                    <p className="text-xs text-slate-500 italic mt-2">
                      + {Object.keys(fundingStats.funderBreakdown).length - 5} more funder{Object.keys(fundingStats.funderBreakdown).length - 5 !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              )}
            </div>
            <DollarSign className="w-16 h-16 text-emerald-200" />
          </div>
        </Card>
      )}

      <div className="flex justify-end mb-4 printable-hidden">
        <Link
          to={createPageUrl(`PrintPipeline?organizationId=${organizationId}`)}
          target="_blank"
        >
          <Button variant="outline">
            <Printer className="w-4 h-4 mr-2" />
            Print Pipeline
          </Button>
        </Link>
      </div>

      {safeGrants.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border">
          <Kanban className="w-16 h-16 mx-auto text-slate-300 mb-4" />
          <h3 className="text-xl font-semibold text-slate-900 mb-2">
            No Grants Yet
          </h3>
          <p className="text-slate-600 mb-4">
            Start by discovering grants for this profile.
          </p>
          <Link to={createPageUrl("DiscoverGrants")}>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Search className="w-4 h-4 mr-2" />
              Discover Grants
            </Button>
          </Link>
        </div>
      ) : (
        <ErrorBoundary message="Could not load the grant pipeline for this profile.">
          <KanbanBoard
            grants={safeGrants}
            organizations={[organization]}
            onUpdateGrant={onGrantUpdate}
            onDeleteGrant={setGrantToDelete}
          />
        </ErrorBoundary>
      )}
      <AlertDialog open={!!grantToDelete} onOpenChange={() => setGrantToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the grant "{grantToDelete?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteGrantMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteGrant}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteGrantMutation.isPending}
            >
              {deleteGrantMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}