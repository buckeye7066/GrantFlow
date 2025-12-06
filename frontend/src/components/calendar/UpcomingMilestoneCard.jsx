
import React from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { formatDateSafe, parseDateSafe } from '@/components/shared/dateUtils';
import { differenceInDays } from 'date-fns';

// Helper function to determine the icon based on milestone status/type
// This is a placeholder implementation. You might want to use a dedicated icon library
// or more specific logic based on your application's design system.
const getMilestoneIcon = (milestone) => {
  if (milestone.completed) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  // Example: a generic document icon for other types
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
};

// Helper function to determine the urgency class for the date display
const getUrgencyClass = (daysUntilDue) => {
  if (daysUntilDue === null) return 'text-slate-500'; // No due date
  if (daysUntilDue < 0) return 'text-red-600'; // Overdue
  if (daysUntilDue <= 7) return 'text-orange-600'; // Due in 7 days or less
  return 'text-green-600'; // More than 7 days
};

/**
 * Card component for displaying an upcoming milestone
 */
export default function UpcomingMilestoneCard({ milestone, grant }) {
  const navigate = useNavigate();

  const dueDate = parseDateSafe(milestone.due_date);
  const daysUntilDue = dueDate ? differenceInDays(dueDate, new Date()) : null;

  return (
    <li
      onClick={() => navigate(createPageUrl(`GrantDetail?id=${milestone.grant_id}`))}
      className={`p-3 rounded-lg border cursor-pointer hover:shadow-md transition-all ${
        milestone.completed ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'
      }`}
      role="listitem"
    >
      <div className="flex items-start gap-3">
        <div className={`p-1.5 rounded-lg ${
          milestone.completed ? 'bg-emerald-100' : 'bg-slate-100'
        }`}>
          {getMilestoneIcon(milestone)}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className={`font-medium truncate ${
            milestone.completed ? 'text-emerald-900 line-through' : 'text-slate-900'
          }`}>
            {milestone.title}
          </h4>
          {grant && (
            <p className="text-xs text-slate-600 mt-1 truncate">{grant.title}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <span className={`text-xs font-medium ${getUrgencyClass(daysUntilDue)}`}>
              {dueDate ? formatDateSafe(milestone.due_date, 'MMM d') : 'No date'}
            </span>
            {daysUntilDue !== null && !milestone.completed && (
              <span className="text-xs text-slate-500">
                {daysUntilDue === 0 ? '• Today' : daysUntilDue === 1 ? '• Tomorrow' : `• ${daysUntilDue}d`}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
