import React from 'react';

/**
 * Reusable stat card for opportunity overview
 * @param {Object} props
 * @param {React.Component} props.icon - Lucide icon component
 * @param {string} props.label - Stat label
 * @param {string} props.value - Stat value
 * @param {string} props.color - Icon color class (e.g., 'text-emerald-600')
 * @param {string} props.bgColor - Background color class (e.g., 'bg-emerald-50')
 */
export default function OpportunityStatCard({ icon: Icon, label, value, color, bgColor }) {
  return (
    <div className="flex flex-col p-4 rounded-lg bg-slate-50 border border-slate-200 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
        <div className={`p-1.5 rounded ${bgColor || 'bg-slate-100'}`}>
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <span>{label}</span>
      </div>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}