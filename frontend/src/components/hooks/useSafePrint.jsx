import { useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';

/**
 * Safe print utility hook
 * Ensures all data is loaded before triggering print
 * 
 * @param {Object} loadingStates - Object with loading flags
 * @returns {Function} Print function
 */
export function useSafePrint(loadingStates = {}) {
  const { toast } = useToast();

  const triggerPrint = useCallback(() => {
    // Check if any critical data is still loading
    const isAnyLoading = Object.values(loadingStates).some(state => state === true);

    if (isAnyLoading) {
      toast({
        title: "Data Loading",
        description: "Please wait for all data to load before printing.",
        variant: "warning",
      });
      return;
    }

    // Trigger browser print
    window.print();
  }, [loadingStates, toast]);

  return triggerPrint;
}