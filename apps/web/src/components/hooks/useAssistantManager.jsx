import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/ui/use-toast';

const isBrowser = typeof window !== 'undefined';

/**
 * Custom hook for managing assistant modal states
 * Backward compatible: still returns isPortalAssistantOpen / isApplicationAssistantOpen / isSubmissionAssistantOpen
 * Internally uses a single source of truth (activeAssistant) to avoid state drift.
 */
export function useAssistantManager() {
  const { toast } = useToast();

  // Single source of truth
  const [activeAssistant, setActiveAssistant] = useState(null);
  const prevAssistantRef = useRef(null);

  // Back-compat booleans (derived)
  const isPortalAssistantOpen = activeAssistant === 'portal';
  const isApplicationAssistantOpen = activeAssistant === 'application';
  const isSubmissionAssistantOpen = activeAssistant === 'submission';

  /**
   * Open a specific assistant. If the same assistant is already active, no-op.
   */
  const openAssistant = useCallback((type) => {
    if (type !== 'portal' && type !== 'application' && type !== 'submission') {
      console.warn('[useAssistantManager] Unknown assistant type:', type);
      return;
    }
    setActiveAssistant((prev) => {
      if (prev === type) return prev; // no-op
      return type;
    });
  }, []);

  /**
   * Close a specific assistant (only if currently active), or close all when no type provided.
   */
  const closeAssistant = useCallback((type) => {
    setActiveAssistant((prev) => {
      if (!type) return null; // close all
      if (type !== 'portal' && type !== 'application' && type !== 'submission') {
        console.warn('[useAssistantManager] Unknown assistant type:', type);
        return prev;
      }
      return prev === type ? null : prev;
    });
  }, []);

  // Toast when switching (only toast on actual change, suppress duplicates)
  useEffect(() => {
    if (activeAssistant && activeAssistant !== prevAssistantRef.current) {
      const label =
        activeAssistant === 'portal'
          ? 'Portal Assistant'
          : activeAssistant === 'application'
          ? 'Application Assistant'
          : 'Submission Assistant';
      toast({
        title: `${label} Activated`,
        description: 'Assistant opened successfully.',
      });
    }
    prevAssistantRef.current = activeAssistant;
  }, [activeAssistant, toast]);

  // Handle external events safely (SSR guard)
  useEffect(() => {
    if (!isBrowser) return;

    const handleOpenPortalAssistant = (event) => {
      openAssistant('portal');
    };

    const handleOpenApplicationAssistant = (event) => {
      openAssistant('application');
    };

    const handleOpenSubmissionAssistant = (event) => {
      openAssistant('submission');
    };

    // Generic channel: `assistant:open` with detail { type: 'portal' | 'application' | 'submission' }
    const handleGenericOpen = (event) => {
      const detail = event?.detail;
      const t = detail?.type;
      if (t === 'portal' || t === 'application' || t === 'submission') {
        openAssistant(t);
      }
    };

    window.addEventListener('openPortalAssistant', handleOpenPortalAssistant);
    window.addEventListener('openApplicationAssistant', handleOpenApplicationAssistant);
    window.addEventListener('openSubmissionAssistant', handleOpenSubmissionAssistant);
    window.addEventListener('assistant:open', handleGenericOpen);

    return () => {
      window.removeEventListener('openPortalAssistant', handleOpenPortalAssistant);
      window.removeEventListener('openApplicationAssistant', handleOpenApplicationAssistant);
      window.removeEventListener('openSubmissionAssistant', handleOpenSubmissionAssistant);
      window.removeEventListener('assistant:open', handleGenericOpen);
    };
  }, [openAssistant]);

  // Memoize returned object to stabilize references where possible
  return useMemo(
    () => ({
      // Backward compatible flags
      isPortalAssistantOpen,
      isApplicationAssistantOpen,
      isSubmissionAssistantOpen,
      // Controls
      openAssistant,
      closeAssistant,
    }),
    [
      isPortalAssistantOpen,
      isApplicationAssistantOpen,
      isSubmissionAssistantOpen,
      openAssistant,
      closeAssistant,
    ]
  );
}