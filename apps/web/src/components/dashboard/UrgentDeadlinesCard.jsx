import React, { useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, AlertTriangle, Calendar as CalendarIcon, ArrowRight, CheckCircle2, Plus } from "lucide-react";
import { formatDateSafe, parseDateSafe } from '@/components/shared/dateUtils';
import { differenceInDays } from 'date-fns';

// Named constants
const URGENT_DAYS_THRESHOLD = 7;
const CRITICAL_DAYS_THRESHOLD = 3;

/** Safe differenceInDays with try/catch */
const safeDifferenceInDays = (date, baseDate) => {
  if (!date) return null;
  try {
    return differenceInDays(date, baseDate);
  } catch {
    return null;
  }
};

export default function UrgentDeadlinesCard({ urgentDeadlines = [], onAddGrant }) {
  const navigate = useNavigate();

  // Memoize safe deadlines array
  const safeDeadlines = useMemo(() => {
    return Array.isArray(urgentDeadlines) ? urgentDeadlines : [];
  }, [urgentDeadlines]);

  const handleNavigate = useCallback((grantId) => {
    if (grantId) {
      navigate(createPageUrl(`GrantDetail?id=${grantId}`));
    }
  }, [navigate]);

  return (
    <Card className="shadow-lg border-0" role="region" aria-label="Urgent deadlines">
      <CardHeader className="border-b border-slate-100">
        <CardTitle className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-amber-500" aria-hidden="true" />
          Urgent Deadlines
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        {safeDeadlines.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-emerald-300" aria-hidden="true" />
            <p className="font-medium mb-2">No Urgent Deadlines</p>
            <p className="text-sm mb-4">You're all caught up!</p>
            {typeof onAddGrant === 'function' && (
              <Button variant="outline" size="sm" onClick={onAddGrant} className="gap-2">
                <Plus className="w-4 h-4" />
                Discover Grants
              </Button>
            )}
          </div>
        ) : (
          <ul className="space-y-3" role="list">
            {safeDeadlines.map((grant) => {
              const grantId = grant?.id;
              const key = grantId || `grant-${grant?.title || Math.random()}`;
              const title = grant?.title || 'Untitled Grant';
              const funder = grant?.funder || 'Unknown Funder';
              const deadlineDate = parseDateSafe(grant?.deadline);
              const daysLeft = safeDifferenceInDays(deadlineDate, new Date());
              const isRolling = (grant?.deadline || '').toLowerCase() === 'rolling';
              const isCritical = daysLeft !== null && daysLeft <= CRITICAL_DAYS_THRESHOLD;
              const isUrgent = daysLeft !== null && daysLeft <= URGENT_DAYS_THRESHOLD;

              return (
                <li
                  key={key}
                  role="listitem"
                  aria-label={`${title}, ${isRolling ? 'rolling deadline' : daysLeft !== null ? `${daysLeft} days left` : 'no deadline'}`}
                  onClick={() => handleNavigate(grantId)}
                  className="p-3 bg-amber-50 rounded-lg border border-amber-200 hover:shadow-md transition-all cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      {isCritical && (
                        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1">
                        <h4 className="font-semibold text-slate-900 truncate">{title}</h4>
                        <p className="text-sm text-slate-600 mt-1 truncate">{funder}</p>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          {isRolling ? (
                            <Badge className="bg-blue-100 text-blue-700">Rolling Deadline</Badge>
                          ) : deadlineDate ? (
                            <>
                              <Badge className={
                                daysLeft !== null && daysLeft <= CRITICAL_DAYS_THRESHOLD ? 'bg-red-100 text-red-700' :
                                daysLeft !== null && daysLeft <= URGENT_DAYS_THRESHOLD ? 'bg-amber-100 text-amber-700' :
                                'bg-yellow-100 text-yellow-700'
                              }>
                                {formatDateSafe(grant.deadline, 'MMM d, yyyy')}
                              </Badge>
                              {daysLeft !== null && (
                                <span className={`text-sm ${isCritical ? 'text-red-600 font-medium' : 'text-slate-600'}`}>
                                  {daysLeft === 0 ? 'Due today!' : 
                                   daysLeft === 1 ? '1 day left' : 
                                   daysLeft < 0 ? 'Overdue' :
                                   `${daysLeft} days left`}
                                </span>
                              )}
                            </>
                          ) : (
                            <Badge variant="outline">No deadline</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}