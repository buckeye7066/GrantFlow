import { useMemo } from 'react';

/**
 * Status configurations with visual properties
 */
export const GRANT_STATUSES = [
  { value: "discovered", label: "Discovered", icon: "Layers", color: "bg-slate-100 text-slate-700" },
  { value: "interested", label: "Assessment", icon: "Eye", color: "bg-blue-100 text-blue-700" },
  { value: "auto_applied", label: "Auto-Applied", icon: "CheckCircle", color: "bg-green-100 text-green-700" },
  { value: "drafting", label: "Drafting", icon: "FileEdit", color: "bg-purple-100 text-purple-700" },
  { value: "application_prep", label: "Application Prep", icon: "FileEdit", color: "bg-yellow-100 text-yellow-700" },
  { value: "revision", label: "Revision", icon: "HardHat", color: "bg-orange-200 text-orange-800" },
  { value: "portal", label: "Portal Entry", icon: "HardHat", color: "bg-orange-100 text-orange-700" },
  { value: "submitted", label: "Submitted", icon: "Send", color: "bg-amber-100 text-amber-700" },
  { value: "pending_review", label: "Under Review", icon: "Eye", color: "bg-indigo-100 text-indigo-700" },
  { value: "follow_up", label: "Follow Up", icon: "Send", color: "bg-green-100 text-green-700" },
  { value: "awarded", label: "Awarded", icon: "Award", color: "bg-emerald-100 text-emerald-700" },
  { value: "report", label: "Reporting", icon: "FileBarChart", color: "bg-teal-100 text-teal-700" },
  { value: "declined", label: "Declined", icon: "XCircle", color: "bg-red-100 text-red-700" },
  { value: "closed", label: "Closed", icon: "Archive", color: "bg-gray-100 text-gray-700" },
];

/**
 * Get status configuration by value
 * @param {string} statusValue - Status value to look up
 * @returns {Object|null} Status configuration or null
 */
export function getStatusConfig(statusValue) {
  return GRANT_STATUSES.find(s => s.value === statusValue) || null;
}

/**
 * Hook to group grants by status with sorting
 * FIXED: Added validation for grant.id and better handling of unknown statuses
 * @param {Array} grants - Array of grant objects
 * @returns {Object} Grants grouped by status
 */
export function useGrantsByStatus(grants) {
  return useMemo(() => {
    if (!Array.isArray(grants)) return {};
    
    // Initialize groups for all statuses
    const grouped = GRANT_STATUSES.reduce((acc, status) => {
      acc[status.value] = [];
      return acc;
    }, {});

    // Group grants - FIXED: validate each grant has id and status
    grants.forEach(grant => {
      // Skip invalid grants
      if (!grant || !grant.id) {
        console.warn('[useGrantsByStatus] Skipping grant with missing id');
        return;
      }
      
      const status = grant.status || 'discovered'; // Default to discovered if no status
      
      if (grouped[status]) {
        grouped[status].push(grant);
      } else {
        // Handle unknown status - put in discovered column
        console.warn('[useGrantsByStatus] Unknown status, defaulting to discovered:', status);
        grouped.discovered.push(grant);
      }
    });

    // Sort each group: starred first, then by deadline (soonest first), then by updated_date
    Object.keys(grouped).forEach(status => {
      grouped[status].sort((a, b) => {
        // Starred grants come first
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        
        // Then sort by deadline (soonest first) if both have deadlines
        const deadlineA = a.deadline && a.deadline.toLowerCase() !== 'rolling' ? new Date(a.deadline) : null;
        const deadlineB = b.deadline && b.deadline.toLowerCase() !== 'rolling' ? new Date(b.deadline) : null;
        
        if (deadlineA && deadlineB) {
          return deadlineA - deadlineB;
        }
        if (deadlineA && !deadlineB) return -1;
        if (!deadlineA && deadlineB) return 1;
        
        // Then sort by updated_date (most recent first)
        const dateA = new Date(a.updated_date || a.created_date || 0);
        const dateB = new Date(b.updated_date || b.created_date || 0);
        return dateB - dateA;
      });
    });

    return grouped;
  }, [grants]);
}