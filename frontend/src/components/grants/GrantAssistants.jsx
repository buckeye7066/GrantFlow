import React from 'react';
import GrantPortalAssistant from '../proposals/GrantPortalAssistant';
import AIApplicationAssistant from '../proposals/AIApplicationAssistant';
import SubmissionAssistant from '../proposals/SubmissionAssistant';

/**
 * Wrapper for all grant assistant modals
 */
export default function GrantAssistants({ 
  grant, 
  organization,
  portalOpen,
  applicationOpen,
  submissionOpen,
  onClosePortal,
  onCloseApplication,
  onCloseSubmission
}) {
  if (!organization) return null;

  return (
    <>
      {portalOpen && (
        <GrantPortalAssistant 
          open={portalOpen} 
          onClose={onClosePortal} 
          grant={grant} 
          organization={organization} 
        />
      )}

      {applicationOpen && (
        <AIApplicationAssistant
          open={applicationOpen}
          onClose={onCloseApplication}
          grant={grant}
          organization={organization}
        />
      )}

      {submissionOpen && (
        <SubmissionAssistant
          open={submissionOpen}
          onClose={onCloseSubmission}
          grant={grant}
          organization={organization}
        />
      )}
    </>
  );
}