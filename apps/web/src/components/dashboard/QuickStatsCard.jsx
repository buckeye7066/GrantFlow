import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

// Status constants to avoid typos
const STATUS_DISCOVERED = 'discovered';
const STATUS_INTERESTED = 'interested';
const STATUS_DRAFTING = 'drafting';
const STATUS_SUBMITTED = 'submitted';
const STATUS_AWARDED = 'awarded';

const IN_PROGRESS_STATUSES = [STATUS_INTERESTED, STATUS_DRAFTING];

export default function QuickStatsCard({ grants = [] }) {
  const stats = useMemo(() => {
    const safeGrants = Array.isArray(grants) ? grants : [];
    return {
      discovered: safeGrants.filter(g => g?.status === STATUS_DISCOVERED).length,
      inProgress: safeGrants.filter(g => IN_PROGRESS_STATUSES.includes(g?.status)).length,
      submitted: safeGrants.filter(g => g?.status === STATUS_SUBMITTED).length,
      awarded: safeGrants.filter(g => g?.status === STATUS_AWARDED).length,
    };
  }, [grants]);

  return (
    <Card className="shadow-lg border-0" role="region" aria-label="Quick grant statistics">
      <CardHeader className="border-b border-slate-100 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <BarChart3 className="w-5 h-5 text-purple-500" aria-hidden="true" />
          Quick Stats
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        <dl className="space-y-4">
          <div className="flex justify-between items-center">
            <dt className="text-slate-600">Discovered Grants</dt>
            <dd className="font-bold text-slate-900">{stats.discovered}</dd>
          </div>
          <div className="flex justify-between items-center">
            <dt className="text-slate-600">In Progress</dt>
            <dd className="font-bold text-slate-900">{stats.inProgress}</dd>
          </div>
          <div className="flex justify-between items-center">
            <dt className="text-slate-600">Submitted</dt>
            <dd className="font-bold text-slate-900">{stats.submitted}</dd>
          </div>
          <div className="flex justify-between items-center">
            <dt className="text-slate-600">Awarded</dt>
            <dd className="font-bold text-emerald-600">{stats.awarded}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}