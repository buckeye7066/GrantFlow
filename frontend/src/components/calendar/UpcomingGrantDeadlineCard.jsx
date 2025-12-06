
import React from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Badge } from "@/components/ui/badge";
import { differenceInDays } from "date-fns";
import { formatDateSafe, parseDateSafe } from '@/components/shared/dateUtils';

/**
 * Card component for displaying an upcoming grant deadline
 */
export default function UpcomingGrantDeadlineCard({ grant }) {
  const navigate = useNavigate();

  const deadlineDate = parseDateSafe(grant.deadline);
  // Calculate days left. If deadlineDate is null, daysLeft will be null.
  // If deadlineDate is in the past, differenceInDays will be negative.
  const daysLeft = deadlineDate ? differenceInDays(deadlineDate, new Date()) : null;

  // Helper function to determine badge styling based on daysLeft
  const getBadgeClass = (days) => {
    if (days === null) {
      return "bg-gray-100 text-gray-700"; // No deadline
    }
    if (days <= 0) {
      return "bg-red-100 text-red-700"; // Due today or overdue
    }
    if (days <= 7) {
      return "bg-orange-100 text-orange-700"; // Within 7 days
    }
    if (days <= 30) {
      return "bg-yellow-100 text-yellow-700"; // Within 30 days
    }
    return "bg-green-100 text-green-700"; // More than 30 days
  };

  return (
    <li
      onClick={() => navigate(createPageUrl(`GrantDetail?id=${grant.id}`))}
      className="p-4 bg-white rounded-lg border border-slate-200 hover:shadow-md transition-all cursor-pointer"
      role="listitem"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-slate-900 truncate">{grant.title}</h4>
          <p className="text-sm text-slate-600 mt-1 truncate">{grant.funder}</p>
          <div className="flex items-center gap-3 mt-2">
            <Badge className={getBadgeClass(daysLeft)}>
              {deadlineDate ? formatDateSafe(grant.deadline, 'MMM d, yyyy') : 'No deadline'}
            </Badge>
            {daysLeft !== null && ( // Only show "days left" text if a valid deadline date exists
              <span className="text-sm text-slate-500">
                {daysLeft === 0 ? 'Due today' : daysLeft === 1 ? '1 day left' : `${daysLeft} days left`}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
