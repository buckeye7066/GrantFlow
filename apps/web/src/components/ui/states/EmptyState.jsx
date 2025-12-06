import React from 'react';

/**
 * Generic empty state component
 */
export default function EmptyState({ 
  icon: Icon, 
  title, 
  description, 
  action 
}) {
  return (
    <div className="text-center py-20 px-6 bg-slate-50 rounded-lg">
      {Icon && <Icon className="w-16 h-16 mx-auto text-slate-400" />}
      <h3 className="mt-4 text-xl font-semibold text-slate-800">{title}</h3>
      {description && <p className="mt-2 text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}