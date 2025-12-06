import React from 'react';

/**
 * Scrollable log panel for backfill operations
 */
export default function BackfillLogPanel({ logs = [] }) {
  return (
    <div className="p-4 bg-slate-900 text-white rounded-md font-mono text-sm h-64 overflow-y-auto">
      {logs.length === 0 ? (
        <p className="text-slate-500 italic">No logs yet...</p>
      ) : (
        logs.map((log, index) => (
          <p 
            key={index} 
            className={log.startsWith('ERROR') ? 'text-red-400' : ''}
          >
            {log}
          </p>
        ))
      )}
    </div>
  );
}