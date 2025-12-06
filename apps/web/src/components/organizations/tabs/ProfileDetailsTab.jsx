import React from 'react';
import OrganizationProfileDetails from '../OrganizationProfileDetails';
import ProfileTypeEditor from '../ProfileTypeEditor';
import UniversityApplicationTracker from '@/components/applications/UniversityApplicationTracker';
import TestScoreManager from '@/components/applications/TestScoreManager';
import TranscriptRequestManager from '@/components/applications/TranscriptRequestManager';

/**
 * Profile details tab content
 * Displays editable organization profile information
 */
export default function ProfileDetailsTab({
  organization,
  contactMethods,
  taxonomyItems,
  onUpdate,
  isUpdating,
  scrollToSection,
}) {
  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type);

  return (
    <div className="mt-4 print:mt-0 space-y-6">
      {/* Profile Type Editor - allows changing applicant type */}
      <ProfileTypeEditor
        organization={organization}
        onUpdate={onUpdate}
        isUpdating={isUpdating}
      />

      {isStudent && (
        <>
          <UniversityApplicationTracker 
            organizationId={organization.id}
            isStudent={isStudent}
            organization={organization}
          />
          <TranscriptRequestManager 
            organizationId={organization.id}
            organization={organization}
            isStudent={isStudent}
          />
          <TestScoreManager 
            organizationId={organization.id}
            organization={organization}
            isStudent={isStudent}
          />
        </>
      )}
      
      <OrganizationProfileDetails
        organization={organization}
        contactMethods={contactMethods}
        onUpdate={(payload) => {
          console.log('[ProfileDetailsTab] 📤 onUpdate called with:', payload);
          onUpdate(payload);
        }}
        isUpdating={isUpdating}
        taxonomyItems={taxonomyItems}
        scrollToSection={scrollToSection ? scrollToSection.split('_')[0] : null}
      />
    </div>
  );
}