import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * OrganizationProfileDetails - Display and manage organization profile with event handling
 * 
 * Features:
 * - Listen for 'GrantFlow:profile-update-request' CustomEvent
 * - Call confirmAndSave or onUpdate when event is received
 * - Prefer handlers passed as props
 */

const OrganizationProfileDetails = ({ 
  organization, 
  onUpdate, 
  confirmAndSave,
  children 
}) => {
  const [profile, setProfile] = useState(organization || {});
  const [updateMessage, setUpdateMessage] = useState(null);

  useEffect(() => {
    /**
     * Handle profile update request from PHIDocumentUploader
     */
    const handleProfileUpdateRequest = async (event) => {
      const { payload } = event.detail || {};
      
      if (!payload) {
        console.warn('[OrganizationProfileDetails] Profile update event received with no payload');
        return;
      }

      console.log('[OrganizationProfileDetails] Profile update request received:', payload);

      let handled = false;

      // Try confirmAndSave first if available
      if (confirmAndSave && typeof confirmAndSave === 'function') {
        try {
          await confirmAndSave(payload);
          handled = true;
          setUpdateMessage('Profile updated successfully');
          console.log('[OrganizationProfileDetails] Profile updated via confirmAndSave');
        } catch (error) {
          console.error('[OrganizationProfileDetails] Error in confirmAndSave:', error);
          setUpdateMessage('Error updating profile');
        }
      } 
      // Fall back to onUpdate
      else if (onUpdate && typeof onUpdate === 'function') {
        try {
          await onUpdate(payload);
          handled = true;
          setUpdateMessage('Profile updated successfully');
          console.log('[OrganizationProfileDetails] Profile updated via onUpdate');
        } catch (error) {
          console.error('[OrganizationProfileDetails] Error in onUpdate:', error);
          setUpdateMessage('Error updating profile');
        }
      } else {
        console.warn('[OrganizationProfileDetails] No update handler available');
        setUpdateMessage('No update handler configured');
      }

      // Mark event as handled if we processed it
      if (handled) {
        event.preventDefault();
        
        // Update local profile state
        setProfile(prev => ({ ...prev, ...payload }));

        // Clear message after 3 seconds
        setTimeout(() => {
          setUpdateMessage(null);
        }, 3000);
      }
    };

    // Add event listener
    document.addEventListener('GrantFlow:profile-update-request', handleProfileUpdateRequest);

    // Cleanup on unmount
    return () => {
      document.removeEventListener('GrantFlow:profile-update-request', handleProfileUpdateRequest);
    };
  }, [confirmAndSave, onUpdate]);

  // Update profile state when organization prop changes
  useEffect(() => {
    if (organization) {
      setProfile(organization);
    }
  }, [organization]);

  return (
    <div className="organization-profile-details">
      {updateMessage && (
        <div 
          className="profile-update-message" 
          style={{
            padding: '12px',
            marginBottom: '12px',
            backgroundColor: updateMessage.includes('Error') ? '#fee' : '#efe',
            border: `1px solid ${updateMessage.includes('Error') ? '#fcc' : '#cfc'}`,
            borderRadius: '4px',
            color: updateMessage.includes('Error') ? '#c33' : '#363'
          }}
        >
          {updateMessage}
        </div>
      )}

      <div className="profile-details">
        {typeof children === 'function' ? children(profile) : children}
      </div>
    </div>
  );
};

OrganizationProfileDetails.propTypes = {
  organization: PropTypes.object,
  onUpdate: PropTypes.func,
  confirmAndSave: PropTypes.func,
  children: PropTypes.oneOfType([PropTypes.node, PropTypes.func])
};

OrganizationProfileDetails.defaultProps = {
  organization: null,
  onUpdate: null,
  confirmAndSave: null,
  children: null
};

export default OrganizationProfileDetails;
