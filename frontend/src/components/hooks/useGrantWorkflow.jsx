import { useMemo, useCallback, useRef } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { useSearchParams } from 'react-router-dom';

/**
 * Custom hook for managing grant application workflow
 */
export function useGrantWorkflow(
  grant,
  organization,
  checklistItems,
  runGrantAnalysis,
  updateGrant,
  openAssistant
) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Simple toast cooldown to prevent duplicates on rapid clicks
  const lastToastRef = useRef(0);
  const toastCooldownMs = 800;
  const safeToast = useCallback(
    (opts) => {
      const now = Date.now();
      if (now - lastToastRef.current < toastCooldownMs) return;
      lastToastRef.current = now;
      toast(opts);
    },
    [toast]
  );

  // Memoized derived states with defensive checks
  const isPortalBased = useMemo(() => {
    if (!grant) return false;
    const url = (grant.url || '').toLowerCase();
    const funder = (grant.funder || '').toLowerCase();
    return (
      grant.opportunity_type === 'scholarship' ||
      url.includes('portal') ||
      url.includes('apply') ||
      funder.includes('university') ||
      funder.includes('college')
    );
  }, [grant]);

  const checklistComplete = useMemo(() => {
    const items = Array.isArray(checklistItems) ? checklistItems : [];
    if (items.length === 0) return false;
    const openItems = items.filter((item) => (item?.status || '').toLowerCase() !== 'done');
    return openItems.length === 0;
  }, [checklistItems]);

  const switchToTab = useCallback(
    (tabName) => {
      const currentId = grant?.id;
      if (!currentId) return;
      const currentTab = searchParams.get('tab');
      const currentGrantId = searchParams.get('id');
      if (currentTab === tabName && currentGrantId === currentId) return;
      setSearchParams({ id: currentId, tab: tabName }, { replace: true });
    },
    [grant?.id, searchParams, setSearchParams]
  );

  // Support both updateGrant signatures: (id, data) OR (data)
  const applyUpdateGrant = useCallback(
    async (data) => {
      if (!grant?.id) return;
      try {
        if (updateGrant.length >= 2) {
          // (id, data)
          await updateGrant(grant.id, data);
        } else {
          // (data) with grantId captured in mutation
          await updateGrant(data);
        }
      } catch (e) {
        // Non-fatal: updates are handled elsewhere by caller toasts
      }
    },
    [grant?.id, updateGrant]
  );

  const handleApplyWithAI = useCallback(async () => {
    if (!grant?.id) {
      // Silent no-op; caller may show higher-level warning
      return;
    }

    // If status is application_prep, open submission assistant
    if (grant.status === 'application_prep') {
      openAssistant('submission');
      return;
    }

    // If in portal stage OR detected as portal-based, open portal assistant
    if (grant.status === 'portal' || isPortalBased) {
      openAssistant('portal');
      safeToast({
        title: 'Portal Assistant Ready',
        description: 'Use this to help fill out the application portal.',
      });
      return;
    }

    const items = Array.isArray(checklistItems) ? checklistItems : [];
    const openItems = items.filter((item) => (item?.status || '').toLowerCase() !== 'done');
    const hasNoChecklist = items.length === 0;

    // If in active application stages, check readiness
    if (['drafting', 'application_prep', 'revision'].includes(grant.status || '')) {
      // Check if analysis is complete
      if (grant.ai_status === 'ready' && !!grant.ai_summary) {
        if (hasNoChecklist || checklistComplete) {
          openAssistant('application');
          safeToast({
            title: 'Starting Application Builder',
            description: 'The AI will guide you through writing your proposal.',
          });
          return;
        }
        if (openItems.length > 0) {
          safeToast({
            title: 'Action Required',
            description: `Please complete ${openItems.length} checklist item${openItems.length > 1 ? 's' : ''} first.`,
          });
          switchToTab('checklist');
          return;
        }
      }

      // Analysis not complete, run it
      switchToTab('coach');
      if (!grant.ai_status || grant.ai_status === 'idle' || grant.ai_status === 'error') {
        safeToast({
          title: 'Starting AI Analysis',
          description: 'The AI is analyzing this opportunity for you...',
        });
        // Micro delay to allow tab to render before kicking off analysis
        setTimeout(() => {
          runGrantAnalysis();
        }, 150);
      }
      return;
    }

    // Move to drafting if not already in application stages
    const inAppStages = ['drafting', 'portal', 'application_prep', 'revision', 'submitted'].includes(
      (grant.status || '').toLowerCase()
    );
    if (!inAppStages) {
      await applyUpdateGrant({ status: 'drafting' });
      safeToast({
        title: 'Application Started',
        description: 'Your grant has been moved to the drafting stage.',
      });
    }

    // Switch to coach tab
    switchToTab('coach');

    // If analysis hasn't been run yet, trigger it automatically
    if (!grant.ai_status || grant.ai_status === 'idle' || grant.ai_status === 'error') {
      safeToast({
        title: 'Starting AI Analysis',
        description: 'The AI is analyzing this opportunity for you...',
      });
      setTimeout(() => {
        runGrantAnalysis();
      }, 150);
    } else {
      safeToast({
        title: 'AI Coach Ready',
        description: 'Review the analysis and start building your application.',
      });
    }
  }, [
    grant?.id,
    grant?.status,
    grant?.ai_status,
    grant?.ai_summary,
    isPortalBased,
    checklistItems,
    checklistComplete,
    openAssistant,
    switchToTab,
    runGrantAnalysis,
    applyUpdateGrant,
    safeToast,
  ]);

  return {
    handleApplyWithAI,
    isPortalBased,
    checklistComplete,
  };
}