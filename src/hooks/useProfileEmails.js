import { useState, useCallback, useEffect } from 'react';

/**
 * useProfileEmails Hook
 * Manages multiple email addresses for a profile (up to 10)
 * Handles adding, removing, updating, and setting primary email
 */
const useProfileEmails = (initialEmails = []) => {
    const MAX_EMAILS = 10;
    const [emails, setEmails] = useState(initialEmails);
    const [primaryEmailId, setPrimaryEmailId] = useState(initialEmails[0]?.id || null);
    const [errors, setErrors] = useState({});

    /**
     * Validate email format
     */
    const isValidEmail = useCallback((email) => {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return emailRegex.test(email);
    }, []);

    /**
     * Add a new email address
     */
    const addEmail = useCallback((emailAddress, options = {}) => {
          if (emails.length >= MAX_EMAILS) {
                  setErrors(prev => ({ ...prev, global: `Maximum ${MAX_EMAILS} emails allowed` }));
                  return false;
          }

                                     if (!isValidEmail(emailAddress)) {
                                             setErrors(prev => ({ ...prev, [emailAddress]: 'Invalid email format' }));
                                             return false;
                                     }

                                     if (emails.some(e => e.address === emailAddress)) {
                                             setErrors(prev => ({ ...prev, [emailAddress]: 'Email already added' }));
                                             return false;
                                     }

                                     const newEmail = {
                                             id: `${Date.now()}-${Math.random().toString(36).substring(2)}`,
                                             address: emailAddress,
                                             accessLevel: options.accessLevel || 'edit',
                                             canReceiveNotifications: options.canReceiveNotifications !== false,
                                             notificationPreferences: options.notificationPreferences || { profileUpdates: true, grantMatches: true },
                                             addedDate: new Date().toISOString()
                                     };

                                     setEmails(prev => [...prev, newEmail]);
          setErrors(prev => ({ ...prev, [emailAddress]: undefined }));

                                     if (!primaryEmailId) {
                                             setPrimaryEmailId(newEmail.id);
                                     }

                                     return true;
    }, [emails, primaryEmailId, isValidEmail]);

    /**
     * Remove an email address
     */
    const removeEmail = useCallback((emailId) => {
          const emailToRemove = emails.find(e => e.id === emailId);
          if (!emailToRemove) return false;

                                        setEmails(prev => prev.filter(e => e.id !== emailId));
                                        setErrors(prev => { const { [emailToRemove.address]: _, ...rest } = prev; return rest; });

                                        if (primaryEmailId === emailId) {
                                                const remaining = emails.filter(e => e.id !== emailId);
                                                setPrimaryEmailId(remaining.length > 0 ? remaining[0].id : null);
                                        }

                                        return true;
    }, [emails, primaryEmailId]);

    /**
     * Update email properties
     */
    const updateEmail = useCallback((emailId, updates) => {
          setEmails(prev =>
                  prev.map(email =>
                            email.id === emailId ? { ...email, ...updates, lastModified: new Date().toISOString() } : email
                                 )
                        );
          return true;
    }, []);

    /**
     * Set primary email
     */
    const setPrimaryEmail = useCallback((emailId) => {
          if (!emails.find(e => e.id === emailId)) {
                  setErrors(prev => ({ ...prev, global: 'Email not found' }));
                  return false;
          }
          setPrimaryEmailId(emailId);
          setErrors(prev => ({ ...prev, global: undefined }));
          return true;
    }, [emails]);

    /**
     * Get primary email
     */
    const getPrimaryEmail = useCallback(() => {
          return emails.find(e => e.id === primaryEmailId);
    }, [emails, primaryEmailId]);

    /**
     * Get all email addresses as array
     */
    const getEmailAddresses = useCallback(() => {
          return emails.map(e => e.address);
    }, [emails]);

    /**
     * Update notification preferences for an email
     */
    const updateNotificationPreferences = useCallback((emailId, preferences) => {
          updateEmail(emailId, { notificationPreferences: preferences });
    }, [updateEmail]);

    /**
     * Get notification-enabled emails
     */
    const getNotificationEmails = useCallback((filterType = null) => {
          return emails.filter(e => e.canReceiveNotifications && (
                  !filterType || e.notificationPreferences[filterType]
                ));
    }, [emails]);

    return {
          emails,
          primaryEmailId,
          primaryEmail: getPrimaryEmail(),
          addEmail,
          removeEmail,
          updateEmail,
          setPrimaryEmail,
          getEmailAddresses,
          updateNotificationPreferences,
          getNotificationEmails,
          emailCount: emails.length,
          canAddMore: emails.length < MAX_EMAILS,
          errors,
          maxEmails: MAX_EMAILS
    };
};

export default useProfileEmails;
