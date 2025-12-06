import React, { useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PrintablePipeline from '@/components/pipeline/PrintablePipeline';
import { Loader2, AlertTriangle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createPageUrl } from '@/utils';

// Helper components
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
      <Button variant="outline">&larr; Back to Organizations</Button>
    </Link>
  </div>
);

const AccessDenied = () => (
  <div className="p-6 md:p-8 text-center h-screen flex flex-col items-center justify-center bg-red-50">
    <ShieldAlert className="w-12 h-12 mb-4 text-red-500" />
    <div className="font-semibold text-xl text-red-600">Access Denied</div>
    <div className="text-sm text-red-500 mt-2">You do not have permission to view this profile.</div>
    <Link to={createPageUrl('Organizations')} className="mt-6">
      <Button variant="outline">&larr; Back to Organizations</Button>
    </Link>
  </div>
);

const toMessage = (e) => (e instanceof Error ? e.message : String(e ?? ''));

export default function PrintPipelinePage() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const rawOrganizationId = searchParams.get('organizationId');
  const organizationId =
    rawOrganizationId && rawOrganizationId !== 'undefined' && rawOrganizationId !== 'null'
      ? rawOrganizationId
      : null;

  const printTriggered = useRef(false);

  // Current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Organization (RLS-safe)
  const {
    data: organization,
    isLoading: isLoadingOrg,
    isError: isErrorOrg,
    error: errorOrg,
  } = useQuery({
    queryKey: ['organization', organizationId, user?.email, isAdmin],
    queryFn: async () => {
      if (!organizationId) return null;
      if (isAdmin) return base44.entities.Organization.get(organizationId);
      const results = await base44.entities.Organization.filter({
        id: organizationId,
        created_by: user?.email,
      });
      return results?.[0] || null;
    },
    enabled: !!user?.email && !!organizationId,
    retry: 1,
  });

  // Grants by organization (RLS-safe)
  const {
    data: grants,
    isLoading: isLoadingGrants,
    isError: isErrorGrants,
    error: errorGrants,
  } = useQuery({
    queryKey: ['grants', 'byOrganization', organizationId, user?.email, isAdmin],
    queryFn: async () => {
      if (!organizationId) return [];
      if (isAdmin) {
        return base44.entities.Grant.filter({ organization_id: organizationId });
      }
      return base44.entities.Grant.filter({
        organization_id: organizationId,
        created_by: user?.email,
      });
    },
    enabled: !!user?.email && !!organization,
    retry: 1,
  });

  // Auto-print when ready, then go back
  useEffect(() => {
    const handleAfterPrint = () => {
      // Navigate back after user closes the print dialog
      if (typeof window !== 'undefined' && window.history) {
        window.history.back();
      }
    };

    const canPrint =
      !!user &&
      !isLoadingOrg &&
      !isLoadingGrants &&
      !isErrorOrg &&
      !isErrorGrants &&
      !!organization &&
      !!grants;

    if (canPrint && !printTriggered.current) {
      printTriggered.current = true;

      window.addEventListener('afterprint', handleAfterPrint);
      const timer = window.setTimeout(() => {
        window.print();
      }, 300);

      return () => {
        window.clearTimeout(timer);
        window.removeEventListener('afterprint', handleAfterPrint);
      };
    }
  }, [user, isLoadingOrg, isLoadingGrants, isErrorOrg, isErrorGrants, organization, grants]);

  // Guards & states
  if (!organizationId) {
    return (
      <PageError
        message="Missing Profile ID in URL."
        hint="The link may be broken. Please navigate from a profile."
      />
    );
  }

  if (isLoadingUser) return <PageLoading label="Loading..." />;

  if (isLoadingOrg || isLoadingGrants) return <PageLoading label="Preparing pipeline report..." />;

  if (isErrorOrg) return <PageError message="Could not load the organization profile." hint={toMessage(errorOrg)} />;

  if (isErrorGrants)
    return <PageError message="Could not load the grants for this pipeline." hint={toMessage(errorGrants)} />;

  if (!organization) return <AccessDenied />;

  // Empty grants handled by child component
  return <PrintablePipeline organization={organization} grants={grants || []} />;
}