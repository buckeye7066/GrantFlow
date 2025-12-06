import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';

/** helpers */
const idStr = (v) => (v == null ? '' : String(v));
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isTruthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * Custom hook for billing data fetching and filtering
 * M5 FIX: Use centralized auth context instead of duplicate query
 * @param {string} selectedOrgId - Selected organization ID
 * @returns {Object} All billing data with filters applied
 */
export function useBillingData(selectedOrgId) {
  // M5 FIX: Use centralized auth context
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const canQuery = !!user?.email;

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Organization.list()
        : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: canQuery,
  });

  const { data: projects = [], isLoading: isLoadingProjects } = useQuery({
    queryKey: ['projects', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Project.list()
        : base44.entities.Project.filter({ created_by: user?.email }),
    enabled: canQuery,
  });

  const { data: invoices = [], isLoading: isLoadingInvoices } = useQuery({
    queryKey: ['invoices', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.Invoice.list()
        : base44.entities.Invoice.filter({ created_by: user?.email }),
    enabled: canQuery,
  });

  // H2 FIX: Added RLS filtering and user context to timeLogs query
  const { data: timeLogs = [], isLoading: isLoadingTime } = useQuery({
    queryKey: ['timeLogs', user?.email, isAdmin],
    queryFn: () =>
      isAdmin
        ? base44.entities.TimeEntry.filter({ billed: false })
        : base44.entities.TimeEntry.filter({ billed: false, created_by: user?.email }),
    enabled: canQuery,
  });

  // Normalize once
  const selOrg = idStr(selectedOrgId);
  const orgs = Array.isArray(organizations) ? organizations : [];
  const projs = Array.isArray(projects) ? projects : [];
  const invs = Array.isArray(invoices) ? invoices : [];
  const times = Array.isArray(timeLogs) ? timeLogs : [];

  // Memoized selected organization
  const selectedOrg = useMemo(
    () => orgs.find((o) => idStr(o?.id) === selOrg),
    [orgs, selOrg]
  );

  // Memoized filtered data (string-normalized compare)
  const filteredProjects = useMemo(() => {
    if (!selOrg) return [];
    return projs.filter((p) => idStr(p?.organization_id) === selOrg);
  }, [projs, selOrg]);

  const filteredInvoices = useMemo(() => {
    if (!selOrg) return [];
    return invs.filter((i) => idStr(i?.organization_id) === selOrg);
  }, [invs, selOrg]);

  const filteredTimeLogs = useMemo(() => {
    if (!selOrg) return [];
    return times.filter((t) => idStr(t?.organization_id) === selOrg);
  }, [times, selOrg]);

  // Memoized calculations (safe math + normalization)
  const unbilledTime = useMemo(
    () => filteredTimeLogs.filter((t) => isTruthy(t?.billable)),
    [filteredTimeLogs]
  );

  const unbilledAmount = useMemo(() => {
    // Prefer a provided total_amount; otherwise fall back to (hours * rate) if available.
    return unbilledTime.reduce((sum, t) => {
      const fallback = toNum(t?.hours) * toNum(t?.bill_rate || t?.rate);
      const amt = toNum(t?.total_amount) || fallback;
      return sum + amt;
    }, 0);
  }, [unbilledTime]);

  const unpaidInvoices = useMemo(() => {
    return filteredInvoices.filter((i) => {
      const status = String(i?.status || '').toLowerCase();
      return status !== 'paid' && status !== 'cancelled';
    });
  }, [filteredInvoices]);

  const totalAR = useMemo(() => {
    return unpaidInvoices.reduce((sum, i) => sum + toNum(i?.balance_due), 0);
  }, [unpaidInvoices]);

  const overdueInvoices = useMemo(() => {
    const now = Date.now();
    return filteredInvoices.filter((i) => {
      const status = String(i?.status || '').toLowerCase();
      // If backend sets explicit 'overdue' we include; else compute by due_date < now and not paid
      if (status === 'overdue') return true;
      const due = i?.due_date ? new Date(i.due_date).getTime() : NaN;
      return Number.isFinite(due) && due < now && status !== 'paid';
    });
  }, [filteredInvoices]);

  const activeProjectsCount = useMemo(() => {
    return filteredProjects.filter((p) => String(p?.status || '').toLowerCase() === 'active')
      .length;
  }, [filteredProjects]);

  const isLoading =
    isLoadingUser || isLoadingOrgs || isLoadingProjects || isLoadingInvoices || isLoadingTime;

  return {
    organizations: orgs,
    projects: projs,
    invoices: invs,
    timeLogs: times,
    filteredProjects,
    filteredInvoices,
    filteredTimeLogs,
    selectedOrg,
    unbilledAmount,
    totalAR,
    overdueInvoices,
    activeProjectsCount,
    isLoading,
  };
}