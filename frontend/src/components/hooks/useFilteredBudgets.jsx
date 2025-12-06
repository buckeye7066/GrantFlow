import { useMemo } from 'react';
import { sumBy } from 'lodash';

/**
 * Coerce any value to a finite number or 0
 */
function toNumberSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize id to string (or empty string)
 */
function idStr(v) {
  return v == null ? '' : String(v);
}

/**
 * Custom hook to filter and compute budget data by organization
 * @param {Array} grants - All grants
 * @param {Array} budgetItems - All budget items
 * @param {Array} expenses - All expenses
 * @param {string} selectedOrgId - Selected organization ID
 * @returns {Object} Filtered budget data with computations
 */
export function useFilteredBudgets(
  grants = [],
  budgetItems = [],
  expenses = [],
  selectedOrgId
) {
  return useMemo(() => {
    const selOrg = idStr(selectedOrgId);

    if (!selOrg) {
      return {
        orgGrants: [],
        awardedGrants: [],
        relevantBudgets: [],
        relevantExpenses: [],
        totalBudget: 0,
        totalExpenses: 0,
        remainingBudget: 0,
      };
    }

    // Normalize arrays defensively
    const allGrants = Array.isArray(grants) ? grants : [];
    const allBudgets = Array.isArray(budgetItems) ? budgetItems : [];
    const allExpenses = Array.isArray(expenses) ? expenses : [];

    // Filter grants by organization (string-normalized compare)
    const orgGrants = allGrants.filter((g) => idStr(g?.organization_id) === selOrg);

    // Awarded subset
    const awardedGrants = orgGrants.filter((g) => g?.status === 'awarded');

    // Collect valid grant ids
    const grantIds = new Set(orgGrants.map((g) => idStr(g?.id)).filter(Boolean));

    // Filter budgets and expenses to those grants
    const relevantBudgets = allBudgets.filter((b) => grantIds.has(idStr(b?.grant_id)));
    const relevantExpenses = allExpenses.filter((e) => grantIds.has(idStr(e?.grant_id)));

    // Calculate totals using safe numeric coercion
    const totalBudget = sumBy(relevantBudgets, (b) => toNumberSafe(b?.total)) || 0;
    const totalExpenses = sumBy(relevantExpenses, (e) => toNumberSafe(e?.amount)) || 0;
    const remainingBudget = totalBudget - totalExpenses;

    return {
      orgGrants,
      awardedGrants,
      relevantBudgets,
      relevantExpenses,
      totalBudget,
      totalExpenses,
      remainingBudget,
    };
  }, [grants, budgetItems, expenses, selectedOrgId]);
}