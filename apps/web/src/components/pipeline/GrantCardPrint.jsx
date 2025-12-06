import React from 'react';
import { formatGrantDeadline, formatAwardAmount } from '@/components/shared/grantCardUtils';
import { Badge } from '@/components/ui/badge';
import { Calendar, DollarSign } from 'lucide-react';

/**
 * GrantCardPrint - Individual grant card optimized for print
 * 
 * @param {Object} props
 * @param {Object} props.grant - Grant data
 */
export default function GrantCardPrint({ grant }) {
  if (!grant) return null;

  const deadlineInfo = formatGrantDeadline(grant.deadline);
  const awardAmount = formatAwardAmount(
    grant.award_ceiling || grant.typical_award || grant.awardMax
  );

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 mb-2 break-inside-avoid print-grant-card">
      {/* Grant Title */}
      <h4 className="font-semibold text-slate-900 text-sm leading-tight mb-2">
        {grant.title}
      </h4>

      {/* Funder */}
      {grant.funder && (
        <p className="text-xs text-slate-600 mb-2">
          {grant.funder}
        </p>
      )}

      {/* Summary/Description */}
      {grant.program_description && (
        <p className="text-xs text-slate-700 mb-2 line-clamp-2">
          {grant.program_description}
        </p>
      )}

      {/* Meta Information */}
      <div className="flex flex-wrap gap-2 items-center text-xs">
        {/* Deadline */}
        {deadlineInfo.text && (
          <div className={`flex items-center gap-1 ${
            deadlineInfo.isExpired 
              ? 'text-red-600 font-semibold' 
              : 'text-slate-600'
          }`}>
            <Calendar className="w-3 h-3" aria-hidden="true" />
            <span>{deadlineInfo.text}</span>
          </div>
        )}

        {/* Rolling Badge */}
        {deadlineInfo.isRolling && (
          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
            Rolling
          </Badge>
        )}

        {/* Award Amount */}
        {awardAmount && (
          <div className="flex items-center gap-1 text-slate-600">
            <DollarSign className="w-3 h-3" aria-hidden="true" />
            <span>~{awardAmount}</span>
          </div>
        )}

        {/* Starred Badge */}
        {grant.starred && (
          <Badge className="text-xs bg-yellow-100 text-yellow-800 border-yellow-300">
            ⭐ Priority
          </Badge>
        )}
      </div>

      {/* Tags */}
      {grant.tags && grant.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {grant.tags.slice(0, 3).map((tag) => (
            <Badge 
              key={tag} 
              variant="secondary" 
              className="text-xs px-1.5 py-0"
            >
              {tag}
            </Badge>
          ))}
          {grant.tags.length > 3 && (
            <span className="text-xs text-slate-500">
              +{grant.tags.length - 3} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}