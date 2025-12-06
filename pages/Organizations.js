import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Loader2, Building2, Plus, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// ============================================================================
// POLLING CONFIGURATION
// ============================================================================
// After creating a new organization, the backend may take time to make it
// accessible due to row-level security (RLS) and/or eventual consistency.
// These values control how long we wait and how often we check.
const POLL_INTERVAL_MS = 250;  // Poll every 250ms
const MAX_POLL_DURATION_MS = 5000;  // Maximum 5 seconds of polling

/**
 * Polls the backend for an organization by ID until it becomes available or timeout.
 * This addresses the eventual consistency issue where a just-created organization
 * may not be immediately queryable due to RLS policies or replication delays.
 * 
 * @param {string} organizationId - The ID of the newly created organization
 * @returns {Promise<{success: boolean, organization?: Object, error?: string}>}
 */
async function pollForOrganization(organizationId) {
  const startTime = Date.now();
  let attempts = 0;
  let lastError = null;

  // Polling loop: repeatedly query for the organization until found or timeout
  while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
    attempts++;
    
    try {
      // Attempt to fetch the organization by ID
      const results = await base44.entities.Organization.filter({ id: organizationId });
      
      if (results && results.length > 0) {
        // Organization found - return success
        console.log(
          `[pollForOrganization] Organization ${organizationId} found after ${attempts} attempts (${Date.now() - startTime}ms)`
        );
        return {
          success: true,
          organization: results[0],
          attempts,
          elapsedMs: Date.now() - startTime
        };
      }
    } catch (err) {
      // Store the error but continue polling - the organization may become available
      lastError = err;
      console.warn(
        `[pollForOrganization] Attempt ${attempts} failed for ${organizationId}: ${err.message}`
      );
    }

    // Wait before next poll attempt
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Timeout reached - organization not found within the allowed time
  const elapsedMs = Date.now() - startTime;
  console.error(
    `[pollForOrganization] Timeout after ${attempts} attempts (${elapsedMs}ms) for organization ${organizationId}`
  );
  
  return {
    success: false,
    error: lastError 
      ? `Organization not accessible after ${elapsedMs}ms: ${lastError.message}`
      : `Organization not accessible after ${elapsedMs}ms - the profile may still be processing`,
    attempts,
    elapsedMs
  };
}

export default function Organizations() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    mission: '',
    ein: '',
    website: '',
    focus_areas: '',
    keywords: ''
  });
  
  // Polling state
  const [isPolling, setIsPolling] = useState(false);
  const [pollError, setPollError] = useState(null);

  // Fetch current user
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  // Fetch organizations list
  const { data: organizations = [], isLoading: isLoadingOrgs, refetch: refetchOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => {
      const results = await base44.entities.Organization.filter({});
      return results || [];
    },
  });

  // Create organization mutation
  const createMutation = useMutation({
    mutationFn: async (data) => {
      // Prepare the organization data
      const orgData = {
        name: data.name,
        mission: data.mission,
        ein: data.ein || null,
        website: data.website || null,
        focus_areas: data.focus_areas ? data.focus_areas.split(',').map(s => s.trim()).filter(Boolean) : [],
        keywords: data.keywords ? data.keywords.split(',').map(s => s.trim()).filter(Boolean) : [],
        created_by: user?.id,
        owner_email: user?.email,
      };
      
      // Create the organization
      const createdOrg = await base44.entities.Organization.create(orgData);
      
      if (!createdOrg || !createdOrg.id) {
        throw new Error('Failed to create organization - no ID returned');
      }
      
      return createdOrg;
    },
    onSuccess: async (createdOrg) => {
      console.log(`[Organizations] Organization created with ID: ${createdOrg.id}`);
      
      // Clear any previous poll error
      setPollError(null);
      
      // Start polling to wait for the organization to be accessible
      setIsPolling(true);
      
      try {
        const pollResult = await pollForOrganization(createdOrg.id);
        
        if (pollResult.success) {
          // Success! Navigate to the organization profile
          console.log(`[Organizations] Navigation to profile after successful polling`);
          queryClient.invalidateQueries(['organizations']);
          navigate(`/OrganizationProfile?id=${createdOrg.id}`);
        } else {
          // Polling timed out - show user-friendly error
          console.error(`[Organizations] Polling failed: ${pollResult.error}`);
          setPollError({
            message: 'Your organization was created but is taking longer than expected to become available.',
            details: pollResult.error,
            organizationId: createdOrg.id
          });
          // Refresh the list - the org might appear after a bit more time
          refetchOrgs();
        }
      } catch (err) {
        console.error(`[Organizations] Unexpected polling error: ${err.message}`);
        setPollError({
          message: 'An unexpected error occurred while verifying your organization.',
          details: err.message,
          organizationId: createdOrg.id
        });
      } finally {
        setIsPolling(false);
        setIsFormOpen(false);
        setFormData({ name: '', mission: '', ein: '', website: '', focus_areas: '', keywords: '' });
      }
    },
    onError: (err) => {
      console.error(`[Organizations] Creation failed: ${err.message}`);
      setPollError({
        message: 'Failed to create organization.',
        details: err.message
      });
    }
  });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setPollError({ message: 'Organization name is required.' });
      return;
    }
    setPollError(null);
    createMutation.mutate(formData);
  };

  const handleRetryNavigation = async () => {
    if (!pollError?.organizationId) return;
    
    setIsPolling(true);
    setPollError(null);
    
    try {
      const pollResult = await pollForOrganization(pollError.organizationId);
      
      if (pollResult.success) {
        navigate(`/OrganizationProfile?id=${pollError.organizationId}`);
      } else {
        setPollError({
          message: 'Organization is still not accessible.',
          details: pollResult.error,
          organizationId: pollError.organizationId
        });
      }
    } catch (err) {
      setPollError({
        message: 'An error occurred while checking organization availability.',
        details: err.message,
        organizationId: pollError.organizationId
      });
    } finally {
      setIsPolling(false);
    }
  };

  if (isLoadingUser || isLoadingOrgs) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            Organizations
          </h1>
          <Button onClick={() => setIsFormOpen(true)} disabled={isPolling || createMutation.isPending}>
            <Plus className="w-4 h-4 mr-2" />
            New Organization
          </Button>
        </div>

        {/* Polling/Creating Indicator */}
        {(isPolling || createMutation.isPending) && (
          <Alert className="mb-6 border-blue-200 bg-blue-50">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            <AlertTitle className="text-blue-800">
              {createMutation.isPending ? 'Creating organization...' : 'Verifying organization availability...'}
            </AlertTitle>
            <AlertDescription className="text-blue-700">
              Please wait while we set up your organization profile.
            </AlertDescription>
          </Alert>
        )}

        {/* Error Alert with Retry Option */}
        {pollError && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{pollError.message}</AlertTitle>
            <AlertDescription className="mt-2">
              <p className="text-sm mb-3">{pollError.details}</p>
              {pollError.organizationId && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleRetryNavigation}
                  disabled={isPolling}
                >
                  {isPolling ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    'Try Again'
                  )}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* New Organization Form */}
        {isFormOpen && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Create New Organization</CardTitle>
              <CardDescription>
                Enter the details for your new organization profile.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Organization Name *</Label>
                    <Input
                      id="name"
                      name="name"
                      value={formData.name}
                      onChange={handleInputChange}
                      placeholder="Enter organization name"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ein">EIN (Tax ID)</Label>
                    <Input
                      id="ein"
                      name="ein"
                      value={formData.ein}
                      onChange={handleInputChange}
                      placeholder="XX-XXXXXXX"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mission">Mission Statement</Label>
                  <Textarea
                    id="mission"
                    name="mission"
                    value={formData.mission}
                    onChange={handleInputChange}
                    placeholder="Describe your organization's mission..."
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="website">Website</Label>
                  <Input
                    id="website"
                    name="website"
                    type="url"
                    value={formData.website}
                    onChange={handleInputChange}
                    placeholder="https://example.org"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="focus_areas">Focus Areas (comma-separated)</Label>
                    <Input
                      id="focus_areas"
                      name="focus_areas"
                      value={formData.focus_areas}
                      onChange={handleInputChange}
                      placeholder="Education, Healthcare, Environment"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="keywords">Keywords (comma-separated)</Label>
                    <Input
                      id="keywords"
                      name="keywords"
                      value={formData.keywords}
                      onChange={handleInputChange}
                      placeholder="nonprofit, community, grants"
                    />
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <Button type="submit" disabled={createMutation.isPending || isPolling}>
                    {createMutation.isPending || isPolling ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      'Create Organization'
                    )}
                  </Button>
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={() => setIsFormOpen(false)}
                    disabled={createMutation.isPending || isPolling}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Organizations List */}
        {organizations.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <p className="text-slate-600 mb-4">No organizations found</p>
              <Button onClick={() => setIsFormOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create Your First Organization
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {organizations.map((org) => (
              <Card 
                key={org.id} 
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/OrganizationProfile?id=${org.id}`)}
              >
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-blue-600" />
                    {org.name}
                  </CardTitle>
                  {org.ein && (
                    <CardDescription>EIN: {org.ein}</CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  {org.mission && (
                    <p className="text-sm text-slate-600 line-clamp-2">{org.mission}</p>
                  )}
                  {org.focus_areas && org.focus_areas.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-3">
                      {org.focus_areas.slice(0, 3).map((area, idx) => (
                        <span 
                          key={idx}
                          className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded"
                        >
                          {area}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
