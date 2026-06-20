
import React, { useEffect, useRef, useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import PrintablePipeline from '@/components/pipeline/PrintablePipeline';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createPageUrl, createAbsolutePageUrl } from '@/utils';

// Helper components for different states as per the prompt
const PageLoading = ({ label = 'Loading…' }) => (
  <div className="flex flex-col items-center justify-center h-screen gap-4 text-slate-600">
    <Loader2 className="w-8 h-8 animate-spin" />
    <p>{label}</p>
  </div>
);

const PageError = ({ message, hint }) => (
  <div className="p-6 md:p-8 text-center text-red-600 h-screen flex flex-col items-center justify-center bg-red-50">
    <AlertTriangle className="w-12 h-12 mb-4" />
    <div className="font-semibold text-xl">{message}</div>
    {hint && <div className="text-sm opacity-80 mt-2">{hint}</div>}
    <Link to={createPageUrl('Organizations')} className="mt-6">
      <Button variant="outline">
        &larr; Back to Organizations
      </Button>
    </Link>
  </div>
);

const EmptyState = ({ title, subtitle, action }) => (
  <div className="flex flex-col items-center justify-center h-screen gap-2">
    <h2 className="text-xl font-semibold">{title}</h2>
    {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

const toMessage = (e) => (e instanceof Error ? e.message : String(e ?? ''));

export default function PrintPipelinePage() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const organizationId = searchParams.get('organizationId');
  const printTriggered = useRef(false);

  // Hooks must be called at the top level.
  const { data: organization, isLoading: isLoadingOrg, isError: isErrorOrg, error: errorOrg } = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => client.entities.Organization.get(organizationId),
    enabled: !!organizationId, // Conditionally enable the query
    retry: 1,
  });

  const { data: grants, isLoading: isLoadingGrants, isError: isErrorGrants, error: errorGrants } = useQuery({
    queryKey: ['grants', 'byOrganization', organizationId],
    queryFn: () => client.entities.Grant.filter({ organization_id: organizationId }),
    enabled: !!organizationId, // Only run if organizationId is present
    retry: 1,
  });
  
  // Curated-pipeline guard.
  // The on-screen pipeline is PROFILE-scoped, and the sticky-delete /
  // tombstone system only governs profile-attached grants
  // (reconcileDismissedGrants + the DELETE route both no-op when
  // profile_id IS NULL). An org-scoped fetch, however, also returns
  // profile_id IS NULL discovery orphans — raw crawler rows and expired
  // deadlines the user never sees on the board and cannot make "stay
  // deleted." Those are exactly the "sources I had deleted" that kept
  // reappearing in the printout.
  //
  // Mirror what the user actually curated: if this org has a real profile
  // pipeline, print ONLY the profile-scoped rows; otherwise fall back to the
  // legacy org-only listing so orgs that never adopted profiles still print.
  const curatedGrants = useMemo(() => {
    const all = Array.isArray(grants) ? grants : [];
    const profileScoped = all.filter(
      (g) => g && g.profile_id !== null && g.profile_id !== undefined && g.profile_id !== '',
    );
    return profileScoped.length > 0 ? profileScoped : all;
  }, [grants]);

  // FIX: This effect will now run once all data is loaded and ready.
  // It waits a brief moment for the browser to render the content, then triggers the print dialog.
  useEffect(() => {
    const handleAfterPrint = () => {
        // Use window.history.back() explicitly to avoid ambiguous bare global.
        // If the page has no history (opened in new tab), fall back to the
        // Organizations page so the user is never stranded.
        if (window.history.length > 1) {
          window.history.back();
        } else {
          window.location.href = createAbsolutePageUrl('Organizations');
        }
    };

    const canPrint = !isLoadingOrg && !isLoadingGrants && !isErrorOrg && !isErrorGrants && organization && grants;
    if (canPrint && !printTriggered.current) {
        // Set the flag AFTER scheduling, and reset it in cleanup so
        // React 18 Strict Mode double-invoke does not permanently suppress print.
        printTriggered.current = true;

        const timer = setTimeout(() => {
            // Attach the listener immediately before print so it cannot be
            // removed by a cleanup between attachment and the print dialog.
            window.addEventListener('afterprint', handleAfterPrint, { once: true });
            window.print();
        }, 300);

        return () => {
            clearTimeout(timer);
            window.removeEventListener('afterprint', handleAfterPrint);
            // Do NOT reset printTriggered here. Once print has been scheduled
            // it must not fire again due to reference churn on the same data.
            // The ref persists across re-renders so this is safe.
        };
    }
  }, [isLoadingOrg, isLoadingGrants, isErrorOrg, isErrorGrants, organization, grants]);

  // Now we can safely return based on conditions after all hooks have been called.
  // 1. Guard against missing profileId
  if (!organizationId) {
    return <PageError message="Missing Profile ID in URL." hint="The link may be broken. Please navigate from a profile." />;
  }

  // 2. Handle Loading state
  // Check if organizationId is present, then check loading states for queries.
  // If organizationId is missing, 'enabled' for queries is false, so isLoadingOrg/Grants will be false.
  // The above check for !organizationId handles that case first.
  if (isLoadingOrg || isLoadingGrants) {
    return <PageLoading label="Preparing pipeline report..." />;
  }

  // 3. Handle Error states
  if (isErrorOrg) {
    return <PageError message="Could not load the organization profile." hint={toMessage(errorOrg)} />;
  }
  if (isErrorGrants) {
    return <PageError message="Could not load the grants for this pipeline." hint={toMessage(errorGrants)} />;
  }
  
  // 4. Handle Empty state (Organization not found after loading)
  if (!organization) {
    return <EmptyState 
      title="Profile Not Found" 
      subtitle={`No organization exists with the ID: ${organizationId}`}
      action={
        <Link to={createPageUrl('Organizations')}>
          <Button variant="outline">&larr; Back to Organizations</Button>
        </Link>
      }
    />;
  }
  
  // Note: An empty grants array is a valid state; PrintablePipeline renders a
  // "No grants in pipeline" section so the printed report is never silently blank.
  if (curatedGrants && curatedGrants.length === 0) {
    // Still render PrintablePipeline so it can produce the empty-state printed page,
    // but also log for observability so server-side monitoring can detect empty prints.
    console.warn(
      `[PrintPipeline] Rendering empty pipeline report for organizationId=${organizationId}. ` +
      'No grants found â printed report will show empty state.'
    );
  }

  // 5. Render content on success
  return <PrintablePipeline organization={organization} grants={curatedGrants} />;
}
