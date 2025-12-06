import React, { useState, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, PlayCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * ProcessAllButton
 * Bulk-queues grants for background processing.
 * Uses direct entity updates to bypass function 401 issues.
 */
export default function ProcessAllButton({
  profileId,
  grantIds,
  onQueued,
  disabled = false,
  size = "default",
  variant = "default",
  className = "",
  label = "Process All"
}) {
  const [isEnqueuing, setIsEnqueuing] = useState(false);
  const { toast } = useToast();

  // Normalize and filter grant IDs
  const normalizedGrantIds = useMemo(
    () =>
      Array.isArray(grantIds)
        ? grantIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : [],
    [grantIds]
  );

  const handleEnqueueAll = useCallback(async () => {
    // Profile ID is now optional - we can still queue grants without it
    if (normalizedGrantIds.length === 0) {
      toast({
        variant: "destructive",
        title: "No Grants",
        description: "No grants to process."
      });
      return;
    }

    setIsEnqueuing(true);

    try {
      // Direct entity updates to bypass function 401 issues
      let queuedCount = 0;
      const errors = [];

      for (const gid of normalizedGrantIds) {
        try {
          await base44.entities.Grant.update(gid, {
            ai_status: 'queued',
            locked_by: null,
            locked_at: null
          });
          queuedCount++;
        } catch (updateErr) {
          errors.push({ grant_id: gid, error: updateErr.message });
        }
      }

      const result = {
        queued: queuedCount,
        total: normalizedGrantIds.length,
        errors
      };

      const description =
        result.queued > 0
          ? `${result.queued} of ${result.total} grants queued for processing.`
          : "Unable to queue any grants.";

      toast({
        title: result.queued > 0 ? "✅ Grants Queued" : "⚠️ Queue Issue",
        description,
        variant: result.queued > 0 ? "default" : "destructive"
      });

      if (result.errors.length > 0) {
        console.warn("[ProcessAllButton] Some errors:", result.errors);
      }

      if (typeof onQueued === "function") {
        onQueued(result);
      }
    } catch (error) {
      console.error("[ProcessAllButton] Error:", error);
      const description =
        error instanceof Error ? error.message : "Failed to add grants to queue.";

      toast({
        variant: "destructive",
        title: "Queue Failed",
        description
      });
    } finally {
      setIsEnqueuing(false);
    }
  }, [profileId, normalizedGrantIds, toast, onQueued]);

  return (
    <Button
      type="button"
      onClick={handleEnqueueAll}
      disabled={disabled || isEnqueuing || normalizedGrantIds.length === 0}
      size={size}
      variant={variant}
      className={className}
      aria-busy={isEnqueuing}
    >
      {isEnqueuing ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          Queuing {normalizedGrantIds.length}...
        </>
      ) : (
        <>
          <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
          {label} ({normalizedGrantIds.length})
        </>
      )}
    </Button>
  );
}