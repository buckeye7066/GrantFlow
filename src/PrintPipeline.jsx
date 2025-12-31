
import React, { useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PrintablePipeline from '@/components/pipeline/PrintablePipeline';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createPageUrl } from '@/utils';

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
    queryFn: () => base44.entities.Organization.get(organizationId),
    enabled: !!organizationId, // Conditionally enable the query
    retry: 1,
  });

  const { data: grants, isLoading: isLoadingGrants, isError: isErrorGrants, error: errorGrants } = useQuery({
    queryKey: ['grants', 'byOrganization', organizationId],
    queryFn: () => base44.entities.Grant.filter({ organization_id: organizationId }),
    enabled: !!organizationId, // Only run if organizationId is present
    retry: 1,
  });
  
  // FIX: This effect will now run once all data is loaded and ready.
  // It waits a brief moment for the browser to render the content, then triggers the print dialog.
  useEffect(() => {
    const handleAfterPrint = () => {
        // After the print dialog is closed, navigate back.
        // history.back() is often preferred over navigate(-1) for simple back navigation
        // as it directly manipulates the browser history.
        history.back();
    };

    const canPrint = !isLoadingOrg && !isLoadingGrants && !isErrorOrg && !isErrorGrants && organization && grants;
    if (canPrint && !printTriggered.current) {
        printTriggered.current = true; // Prevents re-triggering on re-renders
        
        // Add event listener for after print dialog closes
        window.addEventListener('afterprint', handleAfterPrint);

        // Give the browser a moment to paint the content before printing
        const timer = setTimeout(() => {
            window.print();
        }, 300); // 300ms delay is usually sufficient

        return () => {
            clearTimeout(timer);
            // Clean up the event listener when the component unmounts or dependencies change
            window.removeEventListener('afterprint', handleAfterPrint);
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
  
  // Note: An empty grants array is a valid state handled by the PrintablePipeline component itself,
  // so we don't need an explicit "EmptyState" for it here. The child component will show "No grants".

  // 5. Render content on success
  return <PrintablePipeline organization={organization} grants={grants || []} />;
}
