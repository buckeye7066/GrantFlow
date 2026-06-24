import React, { useState, useEffect, useRef } from 'react';
import client from '@/api/client';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Building, Mail, Phone, Globe, DollarSign, Target, Award, TrendingUp, Calendar, Info, Loader2, Printer, MapPin, Sparkles, Wand, ImagePlus, Kanban, Search, DatabaseZap, ExternalLink, ArrowRightSquare, AlertCircle } from "lucide-react";
import OrganizationProfileDetails from './OrganizationProfileDetails';
import ProfileFilesPanel from '@/components/profiles/ProfileFilesPanel.jsx';
import KanbanBoard from "@/components/pipeline/KanbanBoard";
import PrintablePipeline from "@/components/pipeline/PrintablePipeline";
import PipelineAutomationPanel from "@/components/pipeline/PipelineAutomationPanel";
import { usePrintMode } from '@/components/hooks/usePrintMode';
import { format, isValid } from "date-fns";
import OrganizationEmailComposer from './OrganizationEmailComposer';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import AutoTimeTracker from '../billing/AutoTimeTracker';
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { createLogger } from "@/utils/logger";
import { useAuthStore } from "@/stores/authStore";
import { isRealProfileId } from "@/api/profileIdGuards";
import { useAuthenticatedAvatar } from "@/hooks/useAuthenticatedAvatar";
import { runProfileAvatarLookup } from "@/services/profileAvatarAI";
import { matchProfileToGrants } from "@/api/matching";


const capitalize = (s) => s && s.charAt(0).toUpperCase() + s.slice(1);

// Safely validate a URL has an http/https scheme before opening it.
const isSafeHttpUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// REBUILT: This component is now a "dumb" component. It receives all data as props
// and passes all update events up to the parent. It no longer fetches its own data.
export default function OrganizationProfile({
  organizationId,
  retryKey = 0,
  documents = [],
  isLoadingDocuments = false,
  taxonomyItems = [],
  onDocumentsRefetch
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const log = React.useMemo(() => createLogger("OrganizationProfile"), [])
  const setActiveProfileId = useAuthStore((state) => state.setActiveProfileId);
  const [activeTab, setActiveTab] = useState('details');
  const [isEmailComposerOpen, setIsEmailComposerOpen] = useState(false);
  const [isFindingPicture, setIsFindingPicture] = useState(false);
  const [imgError, setImgError] = React.useState(false);
  const [manualRetryCount, setManualRetryCount] = React.useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const isPrint = usePrintMode();
  // Track a pending "Wait & Retry" timeout so we can clear it on unmount.
  const waitRetryTimeoutRef = useRef(null);

  // Fetch organization data based on organizationId
  const { data: orgData, isLoading, error, refetch } = useQuery({
    queryKey: ['organization', organizationId, retryKey, manualRetryCount],
    queryFn: async () => {
      log.debug('fetching organization', { organizationId })

      // Only apply the propagation delay on the very first attempt (no prior
      // manual retries / retryKey bumps). Existing profiles load immediately.
      if (retryKey === 0 && manualRetryCount === 0) {
        // Check if we already have this in cache (from upload). Read the same
        // composite key the query writes so manual retries actually bypass it.
        const cached = queryClient.getQueryData(['organization', organizationId, retryKey, manualRetryCount]);
        if (cached) {
          log.debug('found in cache; using cached data')
          return cached;
        }
        // Add delay to allow database propagation for freshly created profiles.
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      try {
        // FIXED: Use Profile API instead of Organization API since IDs are profile IDs
        const result = await client.entities.Profile.get(organizationId);
        log.debug('query completed')

        if (!result) {
          throw new Error('Organization not found');
        }

        return result;
      } catch (err) {
        console.error('[OrganizationProfile] Error fetching organization:', err);
        throw err;
      }
    },
    enabled: !!organizationId,
    retry: (failureCount, error) => {
      // Don't retry on 404 (profile doesn't exist)
      if (error?.response?.status === 404 || error?.message?.includes('not found')) {
        return false;
      }
      // Retry up to 3 times for other errors
      return failureCount < 3;
    },
    retryDelay: (attemptIndex) => {
      // Shorter retry delays: 500ms, 1s, 2s — capped at 2000ms.
      return Math.min(500 * Math.pow(2, attemptIndex), 2000);
    },
    staleTime: 0,
    // Add gcTime to keep data in cache longer
    gcTime: 1000 * 60 * 5, // 5 minutes
  });


  // Reintroduced useQuery hook for contactMethods
  const { data: contactMethods = [], isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contactMethods', organizationId],
    queryFn: () => client.entities.ContactMethod.filter({ organization_id: organizationId }),
    enabled: !!organizationId, // Only run if organization.id is available
  });

  // Fetch grants for this organization - including drafting stage.
  // NOTE: this is the RAW, unscored pipeline (every grant row attached to the
  // org). It backs the "Pipeline View" kanban (which must show the user's whole
  // board). It must NOT back the "Opportunities" count — see matchedOpportunities
  // below — because that count is meant to mean "matched funding opportunities"
  // (the SAME number the profile-level Pipeline reports as "N matched"), not the
  // raw row count, which includes legacy/orphan/low-score rows the matcher hides.
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', organizationId],
    queryFn: () => client.entities.Grant.filter({ organization_id: organizationId }),
    enabled: !!organizationId,
  });

  // Canonical MATCHED opportunities for this profile — the single matching
  // authority shared with the profile-level Pipeline "N matched" surface
  // (GET /api/matching/profile/:id/grants → computeMatchDecision, REJECTs and
  // no-reason rows dropped). Both surfaces now read from this one query so the
  // org "Opportunities (N)" badge and the profile "N matched" count agree.
  // `organizationId` here is actually the profile id (see Profile.get above).
  const { data: matchedOpportunities = [], isLoading: isLoadingMatched } = useQuery({
    queryKey: ['matchedOpportunities', organizationId],
    queryFn: () => matchProfileToGrants(organizationId),
    enabled: !!organizationId,
  });

  // NEW: Fetch funding sources for this organization
  const { data: fundingSources = [], isLoading: isLoadingSources } = useQuery({
    queryKey: ['fundingSources', organizationId],
    queryFn: () => client.entities.SourceDirectory.filter({ discovered_for_organization_id: organizationId }),
    enabled: !!organizationId,
  });

  // Log grants to verify drafting grants are included
  React.useEffect(() => {
    if (grants.length > 0 && orgData) {
      const draftingGrants = grants.filter(g => g.status === 'drafting');
      log.debug('grants loaded', { total: grants.length, drafting: draftingGrants.length })
    }
  }, [grants, orgData]);

  // Clear any pending "Wait & Retry" timeout on unmount to avoid state updates
  // on an unmounted component.
  useEffect(() => {
    return () => {
      if (waitRetryTimeoutRef.current) {
        clearTimeout(waitRetryTimeoutRef.current);
        waitRetryTimeoutRef.current = null;
      }
    };
  }, []);


  // Flatten sections data into orgData so child components can read flat fields.
  // Precedence: top-level orgData fields win over section.data; among sections,
  // earlier sections win for duplicate scalar keys, but plain object values are
  // deep-merged so later sections do not silently drop nested data.
  const flatOrgData = React.useMemo(() => {
    if (!orgData) return null;
    if (!Array.isArray(orgData.sections) || orgData.sections.length === 0) return orgData;

    const isPlainObject = (v) =>
      v && typeof v === 'object' && !Array.isArray(v);

    const deepMerge = (target, source) => {
      const out = { ...target };
      Object.entries(source).forEach(([key, value]) => {
        if (isPlainObject(value) && isPlainObject(out[key])) {
          out[key] = deepMerge(out[key], value);
        } else if (out[key] === undefined || out[key] === null) {
          out[key] = value;
        }
      });
      return out;
    };

    let flat = { ...orgData };
    orgData.sections.forEach(section => {
      if (section && section.data && typeof section.data === 'object') {
        flat = deepMerge(flat, section.data);
      }
    });

    // Also ensure keywords comes from tags if not set
    if (!flat.keywords && Array.isArray(flat.tags)) {
      flat.keywords = flat.tags;
    }
    return flat;
  }, [orgData]);

  const avatarSourceUrl = React.useMemo(() => {
    if (!orgData) return null
    return orgData.avatar_download_url || orgData.profile_image_url || orgData.avatar_url || null
  }, [orgData])

  const { blobUrl: avatarSrc } = useAuthenticatedAvatar(avatarSourceUrl)

  const emails = contactMethods.filter(c => c.type === 'email');
  const phones = contactMethods.filter(c => c.type === 'phone');

  useEffect(() => {
    if (isRealProfileId(organizationId)) {
      setActiveProfileId(organizationId);
    }
  }, [organizationId, setActiveProfileId]);

  useEffect(() => {
    // Reset image error state when organization's profile image URL changes
    setImgError(false);
  }, [avatarSourceUrl]);


  const handleEditProfile = React.useCallback(() => {
    if (!organizationId) return
    navigate(createPageUrl('ProfileDetail', { id: organizationId }))
  }, [navigate, organizationId])
  const updateGrantMutation = useMutation({
    mutationFn: ({ id, data }) => client.entities.Grant.update(id, data),
    onSuccess: () => {
      // Invalidate grants query to trigger refetch in parent component
      queryClient.invalidateQueries({ queryKey: ['grants', organizationId] }); // Updated queryKey
    },
    onError: (error) => {
      console.error("Error updating grant:", error);
    }
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (id) => client.entities.Grant.delete(id),
    onSuccess: () => {
      // Invalidate grants query to trigger refetch in parent component
      queryClient.invalidateQueries({ queryKey: ['grants', organizationId] }); // Updated queryKey
    },
    onError: (error) => {
      console.error("Error deleting grant:", error);
    }
  });

  // Add mutation for updating organization (now using Profile API)
  const updateOrgMutation = useMutation({
    mutationFn: ({ id, data }) => client.entities.Profile.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast({
        title: "✓ Saved",
        description: "Your changes have been saved automatically.",
        duration: 2000,
      });
    },
    onError: (error) => {
      console.error("Error updating organization:", error);
      toast({
        variant: "destructive",
        title: "Save Failed",
        description: error.message || "There was an error saving your changes. Please try again.",
      });
    }
  });

  // Add mutation for deleting organization (now using Profile API)
  const deleteOrgMutation = useMutation({
    mutationFn: (id) => client.entities.Profile.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast({
        title: "Profile Deleted",
        description: "The profile has been successfully deleted.",
      });
      navigate(createPageUrl('Organizations'));
    },
    onError: (error) => {
      console.error("Error deleting organization:", error);
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "There was an error deleting the profile.",
      });
    }
  });

  const subtitle = React.useMemo(() => {
    if (!orgData) return '';
    if (orgData.applicant_type === 'organization') {
        // Use taxonomyItems from props
        const orgType = taxonomyItems.find(t => t.group === 'organization_type' && t.slug === orgData.nonprofit_type);
        return orgType ? orgType.label : 'Organization';
    }
    return (orgData.applicant_type || '').replace(/_/g, ' ').split(' ').map(capitalize).join(' ');
  }, [orgData, taxonomyItems]); // taxonomyItems is now a prop

  if (isLoading) {
    return (
      <div className="flex flex-col justify-center items-center h-full min-h-[400px] gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-slate-500">Loading organization details...</p>
        <p className="text-xs text-slate-400">This may take a moment for newly created profiles</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col justify-center items-center h-full min-h-[400px] p-4 text-center gap-4">
        <div className="p-4 bg-red-50 rounded-lg border border-red-200 max-w-lg">
          <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-red-900 mb-2">Profile Not Found</h3>
          <p className="text-red-700 mb-2">
            The profile couldn't be loaded at this time.
          </p>
          <div className="text-sm text-red-600 mb-4">
            <p>This might happen if:</p>
            <ul className="text-left mt-2 space-y-1 ml-4">
              <li>• The profile was just created and needs a moment to sync</li>
              <li>• There was a temporary connection issue</li>
              <li>• The profile ID is incorrect</li>
            </ul>
          </div>
          <div className="flex gap-3 justify-center flex-wrap">
            <Button
              onClick={() => {
                log.debug('manual retry triggered')
                setManualRetryCount(prev => prev + 1);
                refetch();
              }}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Loader2 className="w-4 h-4 mr-2" />
              Try Again
            </Button>
            <Button
              onClick={() => {
                toast({
                  title: "Waiting for sync...",
                  description: "Waiting 3 seconds for the database to sync, then retrying...",
                });
                if (waitRetryTimeoutRef.current) {
                  clearTimeout(waitRetryTimeoutRef.current);
                }
                waitRetryTimeoutRef.current = setTimeout(() => {
                  waitRetryTimeoutRef.current = null;
                  setManualRetryCount(prev => prev + 1);
                  refetch();
                }, 3000);
              }}
              variant="outline"
              className="border-blue-600 text-blue-600 hover:bg-blue-50"
            >
              Wait & Retry
            </Button>
            <Button
              onClick={() => navigate(createPageUrl('Organizations'))}
              variant="outline"
            >
              ← Back to Profiles
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!orgData) {
    return (
      <div className="flex flex-col justify-center items-center h-full min-h-[400px] gap-4">
        <p className="text-slate-500">Organization not found.</p>
        <Button onClick={() => navigate(createPageUrl('Organizations'))}>
          ← Back to Organizations
        </Button>
      </div>
    );
  }

  const handleGrantUpdate = (id, data) => {
    updateGrantMutation.mutate({ id, data });
  };

  const handleDeleteGrant = (id) => {
    deleteGrantMutation.mutate(id);
  };

  const handleBack = () => {
    navigate(createPageUrl('Organizations'));
  };

  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = () => {
    if (orgData?.id) {
      deleteOrgMutation.mutate(orgData.id);
    }
  };

  const handleUpdate = async ({ id, orgData: updateData }) => {
    updateOrgMutation.mutate({ id, data: updateData });
  };

  const handleFindPicture = async () => {
    const websiteUrl = flatOrgData?.website || orgData?.website || ''
    if (!websiteUrl || websiteUrl === 'none') {
      toast({
        title: 'Website missing',
        description: 'Add a website to this profile before searching for a picture.',
        variant: 'destructive',
      })
      return
    }

    if (!isRealProfileId(organizationId)) {
      toast({
        title: 'Profile unavailable',
        description: 'Select a saved profile before running AI picture lookup.',
        variant: 'destructive',
      })
      return
    }

    setIsFindingPicture(true)
    try {
      const result = await runProfileAvatarLookup(organizationId, {
        websiteHint: websiteUrl,
      })

      await queryClient.invalidateQueries({ queryKey: ['organization', organizationId] })
      await queryClient.invalidateQueries({ queryKey: ['profile', organizationId] })

      if (result && result.ok) {
        toast({
          title: 'Picture found',
          description: 'We saved a profile photo from the organization website.',
        })
      } else {
        toast({
          title: 'Picture not found',
          description: 'We could not find a usable logo or photo on that website. You can upload one manually.',
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('Error finding picture:', error)
      toast({
        title: 'Error searching',
        description: error?.message || 'Could not complete AI picture lookup. Try again or upload manually.',
        variant: 'destructive',
      })
    } finally {
      setIsFindingPicture(false)
    }
  };

  const triggerPrint = () => {
    // Wait for the per-section data to be loaded before printing.
    if (isLoadingContacts || isLoadingGrants || !orgData) {
        toast({
          title: "Data Loading",
          description: "Some data is still loading, please wait a moment before printing.",
        });
        return;
    }
    // Direct call to the browser's native print function.
    window.print();
  };

  // Get status badge color
  const getStatusBadge = (status) => {
    const statusConfig = {
      discovered: { label: 'Discovered', className: 'bg-slate-100 text-slate-700' },
      interested: { label: 'Interested', className: 'bg-blue-100 text-blue-700' },
      auto_applied: { label: 'Auto Applied', className: 'bg-purple-100 text-purple-700' },
      drafting: { label: 'Drafting', className: 'bg-amber-100 text-amber-700' },
      portal: { label: 'Portal', className: 'bg-indigo-100 text-indigo-700' },
      application_prep: { label: 'App Prep', className: 'bg-orange-100 text-orange-700' },
      revision: { label: 'Revision', className: 'bg-yellow-100 text-yellow-700' },
      submitted: { label: 'Submitted', className: 'bg-emerald-100 text-emerald-700' },
      awarded: { label: 'Awarded', className: 'bg-green-100 text-green-700' },
      declined: { label: 'Declined', className: 'bg-red-100 text-red-700' },
      closed: { label: 'Closed', className: 'bg-slate-100 text-slate-700' },
      report: { label: 'Reporting', className: 'bg-cyan-100 text-cyan-700' },
    };
    return statusConfig[status] || statusConfig.discovered;
  };

  const handleOpenExternal = (url) => {
    if (!isSafeHttpUrl(url)) {
      toast({
        title: 'Invalid link',
        description: 'This source has no valid website URL.',
        variant: 'destructive',
      });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    // FIX: Removed ref={componentRef} from the main container.
    <div className="min-h-full flex flex-col">
      {/* PrintableProfile component is no longer conditionally rendered separately. The main component is styled for print. */}

      <header className="p-6 border-b bg-white flex justify-between items-start printable-hidden flex-shrink-0">
        <div className="flex items-start gap-6">
            <div className="relative group">
                {/* Conditional rendering based on profile_image_url and imgError state */}
                {avatarSrc && !imgError ? (
                    <img
                      src={avatarSrc}
                      alt={orgData.name}
                      className="w-24 h-24 rounded-xl object-cover border-2 border-slate-100"
                      onError={() => setImgError(true)} // Set imgError to true if image fails to load
                    />
                ) : (
                    <div className="w-24 h-24 rounded-xl bg-slate-100 flex items-center justify-center border-2 border-dashed">
                        <ImagePlus className="w-8 h-8 text-slate-400" />
                    </div>
                )}
                 <div
                    className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 flex items-center justify-center rounded-xl transition-opacity cursor-pointer"
                    onClick={handleEditProfile}
                 >
                    <span className="text-white font-bold opacity-0 group-hover:opacity-100 transition-opacity text-sm">Upload</span>
                </div>
            </div>
            <div>
              <Button variant="ghost" onClick={handleBack} className="mb-2 -ml-3 h-auto p-2">
                &larr; Back to list
              </Button>
              <h1 className="text-3xl font-bold text-slate-900">{orgData.display_name ?? orgData.name}</h1>
              <p className="text-md text-slate-600 mt-1">{subtitle}</p>
              {(!avatarSrc || imgError) && (
                  <Button variant="outline" size="sm" className="mt-3" onClick={handleFindPicture} disabled={isFindingPicture || updateOrgMutation.isPending}>
                      {isFindingPicture ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                      {isFindingPicture ? 'Searching...' : 'Find Picture with AI'}
                  </Button>
              )}
            </div>
        </div>
        <div className="flex items-start gap-2 flex-wrap">
           {/* Auto-save indicator */}
           {updateOrgMutation.isPending && (
             <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 rounded-lg border border-blue-200">
               <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
               <span className="text-sm text-blue-700">Saving...</span>
             </div>
           )}
           <Button
             variant="outline"
             onClick={handleEditProfile}
           >
             Edit Profile
           </Button>
           <Link to={createPageUrl("Pricing")}>
             <Button variant="outline">
               <DollarSign className="w-4 h-4 mr-2" />
               View Pricing
             </Button>
           </Link>
           <Button
             variant="outline"
             onClick={() => {
               log.debug('email composer opened', { emailCount: emails.length })
               setIsEmailComposerOpen(true);
             }}
             disabled={emails.length === 0 || isLoadingContacts}
           >
             <Sparkles className="w-4 h-4 mr-2" />
             Email for Update
           </Button>
           <Button
             variant="outline"
             onClick={triggerPrint}
           >
             <Printer className="w-4 h-4 mr-2" />
             Print Profile
           </Button>
           <Button variant="destructive" onClick={handleDelete}>Delete</Button>
        </div>
      </header>

      <main className="flex-1 bg-slate-50 printable-profile-container">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="p-4 printable-section">
            <TabsList className="printable-hidden">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="sources">
                Funding Sources {fundingSources.length > 0 && `(${fundingSources.length})`}
              </TabsTrigger>
              <TabsTrigger value="matches">
                Opportunities {matchedOpportunities.length > 0 && `(${matchedOpportunities.length})`}
              </TabsTrigger>
              <TabsTrigger value="pipeline">
                Pipeline View
              </TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="mt-4 print:mt-0">
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 printable-hidden">
                This tab shows a quick summary. Click <strong>Edit Profile</strong> to open every comprehensive application section
                (basic information, organization details, programs &amp; services, financials, location, story &amp; goals, and more).
              </div>
              <OrganizationProfileDetails
                            organization={flatOrgData}
                contactMethods={contactMethods}
                onUpdate={handleUpdate}
                isUpdating={updateOrgMutation.isPending}
                taxonomyItems={taxonomyItems}
              />
            </TabsContent>

            {/* NEW: Funding Sources Tab */}
            <TabsContent value="sources" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DatabaseZap className="w-5 h-5" />
                    Funding Sources Discovered
                  </CardTitle>
                  <p className="text-sm text-slate-600 mt-2">
                    Local funding sources that were discovered for this profile
                  </p>
                </CardHeader>
                <CardContent>
                  {isLoadingSources ? (
                    <div className="flex justify-center items-center py-16">
                      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                    </div>
                  ) : fundingSources.length === 0 ? (
                    <div className="text-center py-16 bg-slate-50 rounded-lg border">
                      <DatabaseZap className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-xl font-semibold text-slate-900 mb-2">No Sources Yet</h3>
                      <p className="text-slate-600 mb-4">
                        Use AI Discovery in Source Directory to find local funding sources for this profile.
                      </p>
                      <Link to={createPageUrl("SourceDirectory")}>
                        <Button className="bg-blue-600 hover:bg-blue-700">
                          <Sparkles className="w-4 h-4 mr-2" />
                          Discover Sources
                        </Button>
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {fundingSources.map((source) => (
                        <div key={source.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold text-slate-900">{source.name}</h4>
                              <Badge variant="outline" className="capitalize">
                                {source.source_type?.replace(/_/g, ' ')}
                              </Badge>
                              {source.active ? (
                                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                  Active
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="bg-slate-50">
                                  Inactive
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-slate-600">
                              {source.city && source.state ? `${source.city}, ${source.state}` : source.state || 'Location not specified'}
                            </p>
                            {source.opportunities_found > 0 && (
                              <p className="text-sm text-blue-600 mt-1">
                                {source.opportunities_found} opportunit{source.opportunities_found === 1 ? 'y' : 'ies'} found
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {source.website_url && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleOpenExternal(source.website_url)}
                              >
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            )}
                            <Link to={createPageUrl("SourceDetail", { id: source.id })}>
                              <Button variant="outline" size="sm">
                                View in Directory
                              </Button>
                            </Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* NEW: Opportunities/Matches Tab */}
            <TabsContent value="matches" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="w-5 h-5" />
                    Funding Opportunities
                  </CardTitle>
                  <p className="text-sm text-slate-600 mt-2">
                    Funding opportunities matched to this profile. This is the same
                    set the profile&apos;s Pipeline reports as matched.
                  </p>
                </CardHeader>
                <CardContent>
                  {isLoadingMatched ? (
                    <div className="flex justify-center items-center py-16">
                      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                    </div>
                  ) : matchedOpportunities.length === 0 ? (
                    <div className="text-center py-16 bg-slate-50 rounded-lg border">
                      <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                      <h3 className="text-xl font-semibold text-slate-900 mb-2">No Matched Opportunities Yet</h3>
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
                    <div className="space-y-2">
                      {matchedOpportunities.map((grant) => {
                        const statusBadge = getStatusBadge(grant.status);
                        const score = Number(grant.match_score);
                        const deadlineDate = grant.deadline ? new Date(grant.deadline) : null;
                        const hasValidDeadline = deadlineDate && isValid(deadlineDate);

                        return (
                          <Link key={grant.grant_id} to={createPageUrl("GrantDetail", { id: grant.grant_id })}>
                            <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50 hover:border-blue-300 transition-all cursor-pointer">
                              <div className="flex-1 min-w-0 pr-4">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="font-semibold text-slate-900 truncate">{grant.title}</h4>
                                </div>
                                <p className="text-sm text-slate-600 truncate">{grant.funder}</p>
                                {hasValidDeadline && (
                                  <div className="flex items-center gap-1 mt-1">
                                    <Calendar className="w-3 h-3 text-slate-400" />
                                    <span className="text-xs text-slate-500">
                                      {format(deadlineDate, 'MMM d, yyyy')}
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                {Number.isFinite(score) && (
                                  <div className="text-right">
                                    <div className="text-sm font-semibold text-blue-600">
                                      {Math.round(score)}%
                                    </div>
                                    <div className="text-xs text-slate-500">Match</div>
                                  </div>
                                )}
                                <Badge className={statusBadge.className}>
                                  {statusBadge.label}
                                </Badge>
                                <ArrowRightSquare className="w-5 h-5 text-slate-400" />
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Renamed: Pipeline View Tab */}
            <TabsContent value="pipeline" className="mt-4 print:hidden">
               {organizationId && (
                 <div className="mb-6">
                   <PipelineAutomationPanel
                     organizationId={organizationId}
                   />
                 </div>
               )}
               <div className="flex justify-end mb-4 printable-hidden">
                  <Link to={createPageUrl("PrintPipeline", { organizationId })} target="_blank">
                    <Button variant="outline"><Printer className="w-4 h-4 mr-2" />Print Pipeline</Button>
                  </Link>
               </div>
               {isLoadingGrants ? (
                 <div className="flex justify-center items-center py-16">
                   <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                 </div>
               ) : grants.length === 0 ? (
                 <div className="text-center py-16 bg-white rounded-lg border">
                   <Kanban className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                   <h3 className="text-xl font-semibold text-slate-900 mb-2">No Grants Yet</h3>
                   <p className="text-slate-600 mb-4">Start by discovering grants for this profile.</p>
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
                      grants={grants}
                      organizations={[orgData]}
                      onGrantUpdate={handleGrantUpdate}
                      onGrantDelete={handleDeleteGrant}
                    />
                 </ErrorBoundary>
               )}
            </TabsContent>

            {/* Documents tab — full upload / parse / URL-import / paste UI */}
            <TabsContent value="documents" className="mt-4">
              <ProfileFilesPanel
                profileId={orgData?.id}
                profileName={orgData?.display_name ?? orgData?.name}
                canDocumentAI={true}
                canDeleteDocuments={true}
              />
            </TabsContent>
          </Tabs>
      </main>

      {/* NEW: Auto Time Tracker */}
      {orgData && (
        <AutoTimeTracker
          organizationId={orgData.id}
          organizationName={orgData.name}
        />
      )}

      {isEmailComposerOpen && emails.length > 0 && (
        <OrganizationEmailComposer
          open={isEmailComposerOpen}
          onClose={() => setIsEmailComposerOpen(false)}
                      organization={flatOrgData}
          emails={emails}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Profile?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{orgData?.name}"? This action cannot be undone and will also delete all related grants, documents, and data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteOrgMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteOrgMutation.isPending}
            >
              {deleteOrgMutation.isPending ? 'Deleting...' : 'Delete Profile'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
