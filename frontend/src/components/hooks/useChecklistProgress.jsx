import { useMemo } from 'react';

/**
 * Calculate checklist progress for each grant
 * @param {Array} grants - Array of grant objects
 * @param {Array} checklistItems - Array of all checklist items
 * @returns {Object} Map of grant ID to progress info
 */
export function useChecklistProgress(grants, checklistItems) {
  return useMemo(() => {
    if (!Array.isArray(grants) || !Array.isArray(checklistItems)) {
      return {};
    }

    const progressMap = {};

    grants.forEach(grant => {
      if (!grant?.id) return;

      // Find items for this grant
      const items = checklistItems.filter(item => item.grant_id === grant.id);
      
      if (items.length === 0) {
        progressMap[grant.id] = null;
        return;
      }

      // Calculate completion
      const completed = items.filter(item => item.status === 'done').length;
      const total = items.length;

      progressMap[grant.id] = {
        completed,
        total,
        percentage: Math.round((completed / total) * 100)
      };
    });

    return progressMap;
  }, [grants, checklistItems]);
}