import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import OrganizationProfile from '@/components/organizations/OrganizationProfile';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader2 } from 'lucide-react';
import ProfileCompletenessAlert from '@/components/organizations/ProfileCompletenessAlert';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';

/**
 * OrganizationProfilePage - RLS-safe, admin-aware wrapper
 * Ensures only authorized users can view a given organization.
 */
export default function OrganizationProfilePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const organizationId = searchParams.get('id');
  const hasValidId = typeof organizationId === 'string' && organizationId.length > 0;

  // Load current user - must be called unconditionally (before any early returns)
  // M7 FIX: Added try/catch wrapper
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[OrganizationProfile] Auth error:', error);
        return null;
      }
    },
  });

  // M6 FIX: Standardized admin check
  const isAdmin = user?.role === 'admin';

  // Load organization with RLS-aware rules - must be called unconditionally
  // M8 FIX: Replaced .get() with RLS-safe filter(), removed invalid sort parameter
  const {
    data: organization,
    isLoading: isLoadingOrg,
  } = useQuery({
    queryKey: ['organizationProfilePage', organizationId, user?.email, isAdmin],
    enabled: !!user?.email && !!organizationId && hasValidId,
    queryFn: async () => {
      if (isAdmin) {
        const results = await base44.entities.Organization.filter({ id: organizationId });
        return results?.[0] ?? null;
      }

      const results = await base44.entities.Organization.filter({
        id: organizationId,
        created_by: user?.email
      });

      return results?.[0] ?? null;
    },
  });

  // Missing ID - render after all hooks are called
  if (!hasValidId) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-7xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No organization ID provided. Please select an organization from the Organizations page.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button onClick={() => navigate(createPageUrl('Organizations'))}>
              ← Back to Organizations
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Still loading?
  if (isLoadingUser || isLoadingOrg) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Unauthorized or not found
  if (!organization) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-7xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              You do not have permission to view this organization, or it does not exist.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button onClick={() => navigate(createPageUrl('Organizations'))}>
              ← Back to Organizations
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Authorized → render profile
  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <OrganizationProfile organizationId={organizationId} />
      </div>
    </div>
  );
}