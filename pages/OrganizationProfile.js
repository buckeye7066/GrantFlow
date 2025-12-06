import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Loader2, Building2, ArrowLeft, Globe, Mail, Phone, MapPin, Edit, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function OrganizationProfile() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const organizationId = searchParams.get('id');

  // Fetch current user for permissions checking
  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  // Fetch organization details
  const { data: organization, isLoading, error, refetch } = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: async () => {
      if (!organizationId) {
        throw new Error('No organization ID provided');
      }
      const results = await base44.entities.Organization.filter({ id: organizationId });
      if (!results || results.length === 0) {
        throw new Error(`Profile ID ${organizationId} not found or not accessible`);
      }
      return results[0];
    },
    enabled: !!organizationId,
    // Retry a few times since the organization might be newly created
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(500 * (attemptIndex + 1), 2000),
  });

  if (!organizationId) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Invalid Request</AlertTitle>
            <AlertDescription>
              No organization ID was provided. Please navigate to this page from the Organizations list.
            </AlertDescription>
          </Alert>
          <Button 
            variant="outline" 
            className="mt-4"
            onClick={() => navigate('/Organizations')}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Organizations
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading organization profile...</p>
        </div>
      </div>
    );
  }

  if (error || !organization) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Organization Not Found</AlertTitle>
            <AlertDescription className="mt-2">
              <p>{error?.message || `Profile ID ${organizationId} not found or not accessible.`}</p>
              <p className="text-sm mt-2">
                If you just created this organization, it may take a moment to become available.
              </p>
            </AlertDescription>
          </Alert>
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              onClick={() => refetch()}
            >
              <Loader2 className="w-4 h-4 mr-2" />
              Retry
            </Button>
            <Button 
              variant="outline"
              onClick={() => navigate('/Organizations')}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Organizations
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <Button 
            variant="ghost"
            onClick={() => navigate('/Organizations')}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Organizations
          </Button>
          <Button variant="outline">
            <Edit className="w-4 h-4 mr-2" />
            Edit Profile
          </Button>
        </div>

        {/* Main Profile Card */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 bg-blue-100 rounded-lg flex items-center justify-center">
                <Building2 className="w-8 h-8 text-blue-600" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-2xl">{organization.name}</CardTitle>
                {organization.ein && (
                  <CardDescription className="text-base">EIN: {organization.ein}</CardDescription>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {organization.mission && (
              <div className="mb-6">
                <h3 className="font-semibold text-slate-900 mb-2">Mission Statement</h3>
                <p className="text-slate-600">{organization.mission}</p>
              </div>
            )}

            {/* Contact Information */}
            <div className="grid gap-4 md:grid-cols-2 mb-6">
              {organization.website && (
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-slate-400" />
                  <a 
                    href={organization.website} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {organization.website}
                  </a>
                </div>
              )}
              {organization.email && (
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-slate-400" />
                  <a href={`mailto:${organization.email}`} className="text-blue-600 hover:underline">
                    {organization.email}
                  </a>
                </div>
              )}
              {organization.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-slate-400" />
                  <span className="text-slate-600">{organization.phone}</span>
                </div>
              )}
              {organization.address && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-slate-400" />
                  <span className="text-slate-600">{organization.address}</span>
                </div>
              )}
            </div>

            {/* Focus Areas */}
            {organization.focus_areas && organization.focus_areas.length > 0 && (
              <div className="mb-6">
                <h3 className="font-semibold text-slate-900 mb-2">Focus Areas</h3>
                <div className="flex flex-wrap gap-2">
                  {organization.focus_areas.map((area, idx) => (
                    <span 
                      key={idx}
                      className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm"
                    >
                      {area}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Keywords */}
            {organization.keywords && organization.keywords.length > 0 && (
              <div>
                <h3 className="font-semibold text-slate-900 mb-2">Keywords</h3>
                <div className="flex flex-wrap gap-2">
                  {organization.keywords.map((keyword, idx) => (
                    <span 
                      key={idx}
                      className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-sm"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Additional Stats/Info */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-3xl font-bold text-blue-600">0</p>
              <p className="text-sm text-slate-600">Active Grants</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-3xl font-bold text-green-600">0</p>
              <p className="text-sm text-slate-600">Pending Applications</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-3xl font-bold text-purple-600">0</p>
              <p className="text-sm text-slate-600">Total Awards</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
