import React from 'react';
import { Award } from 'lucide-react';
import TagList from './TagList';

/**
 * Student-specific information display
 * Shows GPA, major, and grade levels
 */
export default function StudentInfo({ organization, gradeLevelLabels }) {
  const hasGPA = organization.gpa && parseFloat(organization.gpa) > 0;

  return (
    <div className="space-y-1.5">
      {hasGPA && (
        <div className="flex items-center gap-2 text-xs">
          <Award className="w-3 h-3 text-indigo-600" aria-hidden="true" />
          <span className="font-semibold text-slate-700">
            GPA: {parseFloat(organization.gpa).toFixed(2)}
          </span>
        </div>
      )}
      
      {organization.intended_major && (
        <p className="text-xs text-slate-600 truncate">
          <strong>Major:</strong> {organization.intended_major}
        </p>
      )}
      
      {gradeLevelLabels.length > 0 && (
        <TagList items={gradeLevelLabels} limit={2} variant="secondary" />
      )}
    </div>
  );
}