import React from 'react';
import { Loader2, CheckCircle, Clock } from 'lucide-react';

/**
 * Preview list of grants with their processing status
 */
export default function GrantStatusPreview({ grants, isRunning }) {
  if (!grants || grants.length === 0) return null;

  const getStatusDisplay = (grant) => {
    if (grant.ai_status === 'running') {
      return {
        icon: <Loader2 className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" />,
        text: 'Processing...',
        textClass: 'text-blue-600'
      };
    }
    
    if (grant.ai_summary && grant.ai_status === 'ready') {
      return {
        icon: <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />,
        text: 'Complete',
        textClass: 'text-green-600'
      };
    }
    
    return {
      icon: <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />,
      text: 'Pending',
      textClass: 'text-slate-600'
    };
  };

  return (
    <div>
      <h3 className="font-semibold text-slate-700 mb-3">
        {isRunning ? 'Processing Grants:' : 'Grants to be Processed:'}
      </h3>
      <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
        {grants.slice(0, 20).map(grant => {
          const status = getStatusDisplay(grant);
          
          return (
            <div 
              key={grant.id} 
              className="flex items-center justify-between p-3 bg-slate-50 rounded-md border border-slate-200"
            >
              <p className="font-medium text-slate-800 truncate flex-1">
                {grant.title}
              </p>
              <div className="flex items-center gap-2 ml-4">
                {status.icon}
                <span className={`text-sm ${status.textClass} whitespace-nowrap`}>
                  {status.text}
                </span>
              </div>
            </div>
          );
        })}
        {grants.length > 20 && (
          <p className="text-sm text-slate-500 text-center pt-2">
            ...and {grants.length - 20} more grants
          </p>
        )}
      </div>
    </div>
  );
}