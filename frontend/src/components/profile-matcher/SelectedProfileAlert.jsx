import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { User } from 'lucide-react';

/**
 * Alert banner showing selected profile metadata
 */
export default function SelectedProfileAlert({ organization }) {
  if (!organization) return null;

  return (
    <Alert className="bg-blue-50 border-blue-200">
      <User className="h-4 w-4 text-blue-600" />
      <AlertDescription className="text-blue-800">
        <strong>Selected Profile:</strong> {organization.name}
        {organization.applicant_type && (
          <span className="ml-2">({organization.applicant_type.replace(/_/g, ' ')})</span>
        )}
        {organization.state && <span className="ml-2">• {organization.state}</span>}
        {organization.gpa && <span className="ml-2">• GPA: {organization.gpa}</span>}
      </AlertDescription>
    </Alert>
  );
}