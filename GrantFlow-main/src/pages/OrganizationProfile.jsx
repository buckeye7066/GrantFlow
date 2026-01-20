import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import OrganizationProfile from '@/components/organizations/OrganizationProfile';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader2 } from 'lucide-react';
import ErrorBoundary from '@/components/shared/ErrorBoundary';

export default function OrganizationProfilePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const organizationId = searchParams.get('id');
  const [retryCount, setRetryCount] = React.useState(0);

  React.useEffect(() => {
    // If we have an organization ID but it's not loading after a few seconds,
    // try refetching (helps with database consistency issues after creation)
    if (organizationId && retryCount < 3) {
      const timer = setTimeout(() => {
        setRetryCount(prev => prev + 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [organizationId, retryCount]);

  if (!organizationId) {
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

  return (
    <div className="h-full overflow-auto p-6 md:p-8">
      <div className="max-w-7xl mx-auto min-h-full">
        <ErrorBoundary>
          <OrganizationProfile 
            organizationId={organizationId} 
            retryKey={retryCount}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
