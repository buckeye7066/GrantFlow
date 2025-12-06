import React, { useMemo } from 'react';
import { DollarSign, CalendarCheck, BarChart3, ShieldCheck } from 'lucide-react';
import KPIWidget from './KPIWidget';
import { getDaysLeft, getNextDueDate, formatCurrency, formatDate } from './stewardshipHelpers';

/**
 * Grant KPI summary grid
 */
export default function GrantKPIs({ grant, budgetItems = [], expenses = [], reports = [] }) {
  // Memoize calculations
  const { awardFormatted, daysLeft, burnRate, nextReportDue } = useMemo(() => {
    const awardAmount = typeof grant?.award_ceiling === 'number' ? grant.award_ceiling : 0;
    const safeBudgetItems = Array.isArray(budgetItems) ? budgetItems : [];
    const safeExpenses = Array.isArray(expenses) ? expenses : [];

    const totalBudget = safeBudgetItems.reduce((sum, item) => {
      const val = typeof item?.total === 'number' ? item.total : 0;
      return sum + val;
    }, 0);

    const totalSpent = safeExpenses.reduce((sum, item) => {
      const val = typeof item?.amount === 'number' ? item.amount : 0;
      return sum + val;
    }, 0);

    const rate = totalBudget > 0 ? ((totalSpent / totalBudget) * 100).toFixed(1) : '0.0';
    const nextDue = getNextDueDate(reports);

    return {
      awardFormatted: formatCurrency(awardAmount),
      daysLeft: getDaysLeft(grant?.end_date),
      burnRate: `${rate}%`,
      nextReportDue: nextDue ? formatDate(nextDue) : 'None',
    };
  }, [grant, budgetItems, expenses, reports]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6" role="region" aria-label="Grant KPIs">
      <KPIWidget 
        icon={DollarSign} 
        title="Award Amount" 
        value={awardFormatted} 
      />
      <KPIWidget 
        icon={CalendarCheck} 
        title="Days Left in Period" 
        value={daysLeft} 
      />
      <KPIWidget 
        icon={BarChart3} 
        title="Burn Rate" 
        value={burnRate} 
      />
      <KPIWidget 
        icon={ShieldCheck} 
        title="Next Report Due" 
        value={nextReportDue} 
      />
    </div>
  );
}