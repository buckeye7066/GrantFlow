import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

/**
 * Custom hook for managing stewardship data and state with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {boolean} options.enabled - Whether to enable data fetching
 */
export function useStewardshipData({ user, isAdmin, enabled = true } = {}) {
  const [selectedGrantId, setSelectedGrantId] = useState(null);

  // Fetch all stewardship data with RLS filtering and user-aware query key
  const { data, isLoading } = useQuery({
    queryKey: ['stewardshipData', user?.email, isAdmin],
    queryFn: async () => {
      // Fetch grants with RLS
      const grants = isAdmin
        ? await base44.entities.Grant.filter({ status: 'awarded' })
        : await base44.entities.Grant.filter({ status: 'awarded', created_by: user?.email });

      // Fetch related data with RLS
      const [milestones, reports, budgets, expenses] = await Promise.all([
        isAdmin
          ? base44.entities.Milestone.list()
          : base44.entities.Milestone.filter({ created_by: user?.email }),
        isAdmin
          ? base44.entities.ComplianceReport.list()
          : base44.entities.ComplianceReport.filter({ created_by: user?.email }),
        isAdmin
          ? base44.entities.Budget.list()
          : base44.entities.Budget.filter({ created_by: user?.email }),
        isAdmin
          ? base44.entities.Expense.list()
          : base44.entities.Expense.filter({ created_by: user?.email }),
      ]);

      return { grants, milestones, reports, budgets, expenses };
    },
    enabled: enabled && !!user?.email,
  });

  const grants = data?.grants || [];
  
  // Auto-select first grant if none selected
  useEffect(() => {
    if (grants.length > 0 && !selectedGrantId) {
      setSelectedGrantId(grants[0].id);
    }
  }, [grants, selectedGrantId]);

  // Validate selected grant is in filtered list
  useEffect(() => {
    if (selectedGrantId && !grants.find(g => g.id === selectedGrantId)) {
      setSelectedGrantId(grants[0]?.id || null);
    }
  }, [selectedGrantId, grants]);

  // Memoized selected grant
  const selectedGrant = useMemo(() => 
    grants.find(g => g.id === selectedGrantId),
    [grants, selectedGrantId]
  );

  // Memoized filtered data for selected grant
  const filteredData = useMemo(() => {
    if (!selectedGrant || !data) return null;
    
    return {
      milestones: data.milestones.filter(m => m.grant_id === selectedGrant.id),
      reports: data.reports.filter(r => r.grant_id === selectedGrant.id),
      budgetItems: data.budgets.filter(b => b.grant_id === selectedGrant.id),
      expenses: data.expenses.filter(e => e.grant_id === selectedGrant.id),
    };
  }, [selectedGrant, data]);

  const selectGrant = (grantId) => {
    setSelectedGrantId(grantId);
  };

  return {
    grants,
    selectedGrant,
    selectGrant,
    filteredData,
    isLoading,
  };
}