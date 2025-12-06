import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DatabaseZap, ExternalLink, Loader2, Brain } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { useThemeSettings } from '@/components/theme/ThemeSettingsProvider';

export default function FundingSourcesTab({
  fundingSources,
  isLoading,
  organization,
  onRefresh,
}) {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { accentColor, themeClasses } = useThemeSettings();

  // Debug log on mount and when organization changes
  React.useEffect(() => {
    console.log('[FundingSourcesTab] Organization prop received:', {
      hasOrg: !!organization,
      orgId: organization?.id,
      orgName: organization?.name,
      orgKeys: organization ? Object.keys(organization).slice(0, 10) : []
    });
  }, [organization]);

  const handleAIDiscover = async () => {
    // CRITICAL: Validate organization has an ID before anything else
    const orgId = organization?.id;
    
    console.log('[FundingSourcesTab] handleAIDiscover called with organization:', {
      hasOrg: !!organization,
      orgId,
      orgName: organization?.name,
      orgIdType: typeof orgId,
      orgIdLength: orgId?.length
    });
    
    if (!orgId) {
      toast({
        variant: 'destructive',
        title: 'Discovery Failed',
        description: 'profile id is required',
      });
      return;
    }

    // Additional validation
    if (typeof orgId !== 'string' || orgId.length < 10) {
      toast({
        variant: 'destructive',
        title: 'Invalid Profile',
        description: 'Please refresh the page and try again.',
      });
      return;
    }

    setIsDiscovering(true);

    toast({
      title: '🔍 AI Discovery Started',
      description: `Finding funding sources based on ${organization.name}'s profile...`,
    });

    try {
      // Direct function invoke - Platform V2 payload structure
      // CRITICAL: profile_id MUST be at root level of payload
      const payload = {
        profile_id: orgId,
        organization_id: orgId,
        profile_data: { 
          ...organization, 
          id: orgId,
          name: organization.name || 'Unknown Profile',
          zip: organization.zip || '',
          city: organization.city || '',
          state: organization.state || '',
        },
        enable_diagnostics: true,
      };
      
      console.log('[FundingSourcesTab] Invoking discoverLocalSources with:', { 
        profile_id: payload.profile_id, 
        org_name: organization.name,
        payloadKeys: Object.keys(payload)
      });
      
      // Platform V2: invoke() expects {body: payload} wrapping
      const response = await base44.functions.invoke('discoverLocalSources', { body: payload });
      
      // Handle both axios-style response and direct data
      const data = response?.data ?? response;
      console.log('[FundingSourcesTab] Raw response:', response);
      console.log('[FundingSourcesTab] Response data:', data);
      
      if (!data) throw new Error('No response from server');

      // RESPONSE VALIDATION
      if (!data || typeof data !== 'object') {
        throw new Error('Malformed response from server.');
      }
      
      // Log detailed save info
      console.log('[FundingSourcesTab] Discovery result:', {
        success: data.success,
        sources_added: data.sources_added,
        discovered_count: data.discovered_sources?.length,
        summary: data.summary,
        profileIdUsed: data.profileIdUsed
      });

      // PROFILE MISMATCH PROTECTION
      if (data.profileIdUsed && data.profileIdUsed !== organization.id) {
        toast({
          variant: 'destructive',
          title: 'Profile Mismatch Detected',
          description: 'The backend used the WRONG profile. Results were rejected.',
          duration: 10000,
        });
        return;
      }

      // SUCCESS LOGIC
      if (data.success) {
        const newCount = Number(data.sources_added ?? data.summary?.new_sources ?? 0) || 0;
        const totalCount = Number(data.summary?.total_discovered ?? (data.discovered_sources?.length ?? 0)) || 0;
        const savedCount = Number(data.summary?.total_saved ?? data.discovered_sources?.length ?? 0) || 0;

        console.log('[FundingSourcesTab] Discovery response:', {
          newCount,
          totalCount,
          savedCount,
          summary: data.summary,
          profileIdUsed: data.profileIdUsed,
          organizationId: organization.id,
        });

        // Calculate duplicates from summary
        const duplicatesSkipped = Number(data.summary?.duplicates_skipped ?? 0) || 0;
        const updatedCount = Number(data.summary?.updated ?? 0) || 0;
        
        console.log('[FundingSourcesTab] Toast calculation:', {
          savedCount,
          totalCount,
          duplicatesSkipped,
          updatedCount,
          newCount: data.summary?.new_sources
        });

        // Build accurate toast message
        let toastTitle = '✨ Discovery Complete!';
        let toastDescription = '';
        
        if (savedCount > 0) {
          // New sources were saved
          const newSaved = savedCount - updatedCount;
          if (newSaved > 0) {
            toastDescription = `Added ${newSaved} new source${newSaved !== 1 ? 's' : ''} for ${organization.name}.`;
          } else if (updatedCount > 0) {
            toastDescription = `Updated ${updatedCount} existing source${updatedCount !== 1 ? 's' : ''}.`;
          } else {
            toastDescription = `Saved ${savedCount} source${savedCount !== 1 ? 's' : ''} for ${organization.name}.`;
          }
        } else if (duplicatesSkipped > 0) {
          // All were duplicates - this is the actual duplicate case
          toastDescription = `Found ${duplicatesSkipped} source${duplicatesSkipped !== 1 ? 's' : ''} but all already existed.`;
        } else if (totalCount > 0) {
          // Sources were found but not saved for some reason
          toastDescription = `Found ${totalCount} potential sources but none could be saved.`;
        } else {
          // No sources found at all
          toastDescription = 'No sources found. Try updating profile details or adding target colleges.';
        }

        toast({
          title: toastTitle,
          description: toastDescription,
          duration: 6000,
        });

        // GIVE DB TIME TO PROPAGATE
        await new Promise((r) => setTimeout(r, 2000));

        // REFRESH: invalidate and force refetch to show new sources immediately
        await queryClient.invalidateQueries({ queryKey: ['fundingSources', organization.id] });
        await queryClient.refetchQueries({ queryKey: ['fundingSources', organization.id] });
        
        if (onRefresh) {
          await onRefresh();
        }
      } else {
        throw new Error(data.message || data.error || 'Discovery failed.');
      }
    } catch (err) {
      console.error('[FundingSourcesTab] AI Discovery error:', err?.message || err, err?.response?.data);
      const errorMsg = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Unable to discover sources.';
      toast({
        variant: 'destructive',
        title: 'Discovery Failed',
        description: errorMsg,
      });
    } finally {
      setIsDiscovering(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const safeOpen = (url) => {
    if (!url) return;
    try {
      const href = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).href;
      window.open(href, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore invalid URL
    }
  };

  return (
    <Card className={`mt-4 ${themeClasses.surface}`}>
      <CardHeader className="border-b border-white/10 backdrop-blur-sm bg-white/5">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2" style={{ color: accentColor }}>
              <DatabaseZap className="w-5 h-5" />
              Funding Sources Discovered ({fundingSources.length})
            </CardTitle>
            <p className="text-sm text-slate-600 mt-2">
              Local funding sources discovered for this profile
            </p>
          </div>
          <Button
            onClick={handleAIDiscover}
            disabled={isDiscovering || !organization}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {isDiscovering ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Discovering...
              </>
            ) : (
              <>
                <Brain className="w-4 h-4 mr-2" />
                AI Discover Sources
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {fundingSources.length === 0 ? (
          <div className="text-center py-16 bg-slate-50 rounded-lg border">
            <Brain className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">No Sources Yet</h3>
            <p className="text-slate-600 mb-4 max-w-md mx-auto">
              Click "AI Discover Sources" to automatically find local funding sources based on {organization?.name || 'this profile'}'s attributes.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {fundingSources.map((source) => (
              <div key={source.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-slate-900">{source.name}</h4>
                    <Badge variant="outline" className="capitalize">
                      {String(source.source_type || '').replace(/_/g, ' ')}
                    </Badge>
                    {source.active ? (
                      <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-slate-50">Inactive</Badge>
                    )}
                  </div>

                  <p className="text-sm text-slate-600">
                    {source.city && source.state ? `${source.city}, ${source.state}` : source.state || 'Location not specified'}
                  </p>

                  {Number(source.opportunities_found) > 0 && (
                    <p className="text-sm text-blue-600 mt-1">
                      {Number(source.opportunities_found)} opportunit
                      {Number(source.opportunities_found) === 1 ? 'y' : 'ies'} found
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {source.website_url && (
                    <Button variant="ghost" size="sm" onClick={() => safeOpen(source.website_url)}>
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                  )}

                  <Link to={createPageUrl('SourceDirectory')}>
                    <Button variant="outline" size="sm">View in Directory</Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}