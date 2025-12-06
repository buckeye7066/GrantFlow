import React from 'react';
import { CheckCircle, FileCheck, Clock, AlertCircle } from 'lucide-react';

/**
 * Statistics display for backfill operations
 */
export default function BackfillStats({ processed = 0, created = 0, skipped = 0, errors = 0 }) {
  const stats = [
    {
      label: 'Processed',
      value: processed,
      icon: FileCheck,
      color: 'text-slate-900'
    },
    {
      label: 'Created',
      value: created,
      icon: CheckCircle,
      color: 'text-green-600'
    },
    {
      label: 'Skipped',
      value: skipped,
      icon: Clock,
      color: 'text-yellow-600'
    },
    {
      label: 'Errors',
      value: errors,
      icon: AlertCircle,
      color: 'text-red-600'
    }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.label} className="text-center p-4 bg-slate-50 rounded-lg">
            <div className="flex justify-center mb-2">
              <Icon className={`w-5 h-5 ${stat.color}`} />
            </div>
            <p className={`font-bold text-2xl ${stat.color}`}>{stat.value}</p>
            <p className="text-sm text-slate-500 mt-1">{stat.label}</p>
          </div>
        );
      })}
    </div>
  );
}