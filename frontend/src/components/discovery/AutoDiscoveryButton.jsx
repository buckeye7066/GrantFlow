import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, Search } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { callFunction } from '@/components/shared/functionClient';
import { useQueryClient } from '@tanstack/react-query';

export default function AutoDiscoveryButton({ profileId, organizationId, profileName, onComplete, disabled = false }) {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleAutoDiscover = async () => {
    if (!profileId) {
      toast({
        variant: 'destructive',
        title: 'No Profile Selected',
        description: 'Please select a profile to run auto-discovery.',
      });
      return;
    }

    setIsDiscovering(true);

    try {
      toast({
        title: '🔍 Discovering Sources...',
        description: `Analyzing ${profileName || 'profile'} to find perfect-match funding sources...`,
        duration: 5000,
      });

      // Use unified function client - callFunction handles body wrapping internally
      const fnResult = await callFunction('autoDiscoverSources', {
        profile_id: profileId,
        organization_id: organizationId || profileId
      });

      if (!fnResult.ok) {
        throw new Error(fnResult.error || 'Discovery request failed');
      }

      const result = fnResult.data;

      if (!result?.success) {
        throw new Error(result?.error || 'Discovery failed');
      }

      // Invalidate queries in parallel to show new sources/opportunities
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fundingOpportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['sourceDirectory'] })
      ]);

      const discovered = result.sources_discovered || 0;
      const crawled = result.sources_crawled || 0;
      const opportunities = result.total_opportunities_added || 0;

      toast({
        title: `✨ Discovery Complete!`,
        description: `Found ${discovered} new sources, crawled ${crawled}, added ${opportunities} opportunities. Run search to see them!`,
        duration: 10000,
      });

      if (onComplete) {
        onComplete(result);
      }

    } catch (error) {
      console.error('[AutoDiscoveryButton] Error:', error);
      
      toast({
        variant: 'destructive',
        title: 'Discovery Failed',
        description: error?.message || 'Failed to discover funding sources',
      });
    } finally {
      setIsDiscovering(false);
    }
  };

  return (
    <Button
      onClick={handleAutoDiscover}
      disabled={disabled || isDiscovering || !profileId}
      className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 shadow-lg"
    >
      {isDiscovering ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Discovering...
        </>
      ) : (
        <>
          <Sparkles className="w-4 h-4 mr-2" />
          Auto-Discover Sources
        </>
      )}
    </Button>
  );
}