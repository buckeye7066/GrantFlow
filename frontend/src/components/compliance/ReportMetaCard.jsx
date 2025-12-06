import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Calendar, DollarSign } from 'lucide-react';
import { formatDateSafe, formatNumberSafe, toFixedSafe } from '@/components/shared/dateUtils';

/**
 * Safe date formatter using our utility
 */
const formatDate = (dateInput, formatStr = 'MMMM d, yyyy', fallback = 'N/A') => {
  return formatDateSafe(dateInput, formatStr, fallback);
};

/**
 * Safe number formatter for currency
 */
const formatCurrency = (val, fallback = '0') => {
  const result = formatNumberSafe(val, fallback);
  return result === fallback ? fallback : result;
};

/**
 * Report metadata card showing organization, dates, and budget status
 */
export default function ReportMetaCard({ 
  report = {}, 
  organization = {}, 
  financialData 
}) {
  // Memoize derived display values
  const displayData = useMemo(() => {
    const dueDate = formatDate(report?.due_date, 'MMMM d, yyyy', 'Not set');
    const periodStart = report?.report_period_start ? formatDate(report.report_period_start, 'MMM d, yyyy') : null;
    const periodEnd = report?.report_period_end ? formatDate(report.report_period_end, 'MMM d, yyyy') : null;
    const hasPeriod = periodStart && periodEnd && periodStart !== 'N/A' && periodEnd !== 'N/A';
    
    const totalSpent = formatCurrency(financialData?.total_spent);
    const percentSpent = typeof financialData?.percent_spent === 'number' 
      ? toFixedSafe(financialData.percent_spent, 1, '0') 
      : '0';

    return { dueDate, periodStart, periodEnd, hasPeriod, totalSpent, percentSpent };
  }, [report, financialData]);

  return (
    <Card className="shadow-lg border-0" role="region" aria-label="Report information">
      <CardHeader>
        <CardTitle>Report Information</CardTitle>
      </CardHeader>
      <CardContent className="grid md:grid-cols-2 gap-4">
        <div className="flex items-center gap-3">
          <Building2 className="w-5 h-5 text-slate-500" aria-hidden="true" />
          <div>
            <p className="text-xs text-slate-500">Organization</p>
            <p className="font-medium">{organization?.name || 'Unknown Organization'}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Calendar className="w-5 h-5 text-slate-500" aria-hidden="true" />
          <div>
            <p className="text-xs text-slate-500">Due Date</p>
            <p className="font-medium">{displayData.dueDate}</p>
          </div>
        </div>

        {displayData.hasPeriod && (
          <div className="flex items-center gap-3">
            <Calendar className="w-5 h-5 text-slate-500" aria-hidden="true" />
            <div>
              <p className="text-xs text-slate-500">Reporting Period</p>
              <p className="font-medium">
                {displayData.periodStart} - {displayData.periodEnd}
              </p>
            </div>
          </div>
        )}

        {financialData && (
          <div className="flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-slate-500" aria-hidden="true" />
            <div>
              <p className="text-xs text-slate-500">Budget Status</p>
              <p className="font-medium">
                ${displayData.totalSpent} spent ({displayData.percentSpent}%)
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}