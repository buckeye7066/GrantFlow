import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * ProcessNextGrantButton - Enqueues a single grant for background processing
 * Does NOT process directly - adds to queue for backgroundWorker
 */
export default function ProcessNextGrantButton({ 
  profileId, 
  grantId, 
  onQueued,
  disabled = false,
  size = "default",
  variant = "default",
  className = ""
}) {
  const [isEnqueuing, setIsEnqueuing] = useState(false);
  const { toast } = useToast();

  const handleEnqueue = async () => {
    if (!profileId || !grantId) {
      toast({
        variant: 'destructive',
        title: 'Missing Data',
        description: 'Profile ID and Grant ID are required.'
      });
      return;
    }

    setIsEnqueuing(true);

    try {
      const response = await base44.functions.invoke('enqueueGrant', {
        body: {
          profile_id: profileId,
          grant_id: grantId
        }
      });

      const data = response?.data;

      if (data?.success) {
        if (data.already_queued) {
          toast({
            title: 'Already Queued',
            description: 'This grant is already in the processing queue.'
          });
        } else if (data.already_running) {
          toast({
            title: 'Processing',
            description: 'This grant is currently being processed.'
          });
        } else {
          toast({
            title: '✅ Queued for Processing',
            description: 'Grant added to background processing queue.'
          });
        }

        if (onQueued) {
          onQueued(data);
        }
      } else {
        throw new Error(data?.error || 'Failed to enqueue grant');
      }

    } catch (error) {
      console.error('[ProcessNextGrantButton] Error:', error);
      toast({
        variant: 'destructive',
        title: 'Queue Failed',
        description: error?.message || 'Failed to add grant to queue.'
      });
    } finally {
      setIsEnqueuing(false);
    }
  };

  return (
    <Button
      onClick={handleEnqueue}
      disabled={disabled || isEnqueuing || !profileId || !grantId}
      size={size}
      variant={variant}
      className={className}
    >
      {isEnqueuing ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Queuing...
        </>
      ) : (
        <>
          <Zap className="w-4 h-4 mr-2" />
          Process Grant
        </>
      )}
    </Button>
  );
}