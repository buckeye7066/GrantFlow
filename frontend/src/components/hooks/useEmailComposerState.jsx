import { useState, useEffect } from 'react';

/**
 * Manages email composer form state
 * Handles recipient, subject, and body state
 * 
 * @param {Object} organization - Organization data
 * @param {Array} emails - Available email addresses
 * @param {string} initialBody - Initial body content
 * @param {Array} grants - Grants for calculating total applied
 * @returns {Object} Form state and setters
 */
export function useEmailComposerState(organization, emails, initialBody = '', grants = []) {
  // Calculate total funding applied for
  const totalFundingApplied = grants
    .filter(g => ['drafting', 'application_prep', 'revision', 'portal', 'submitted', 'awarded'].includes(g.status))
    .reduce((sum, g) => {
      const amount = g.award_ceiling || g.typical_award || 0;
      return sum + (typeof amount === 'number' ? amount : 0);
    }, 0);

  const formattedTotal = totalFundingApplied > 0 
    ? ` - $${totalFundingApplied.toLocaleString()} Applied` 
    : '';

  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState(`Grant Pipeline Update: ${organization?.name || ''}${formattedTotal}`);
  const [body, setBody] = useState(initialBody);

  // Auto-select first email when emails array changes
  useEffect(() => {
    if (emails.length > 0 && !recipient) {
      setRecipient(emails[0].value);
    }
  }, [emails, recipient]);

  // Update subject when organization or grants change
  useEffect(() => {
    if (organization?.name) {
      const totalApplied = grants
        .filter(g => ['drafting', 'application_prep', 'revision', 'portal', 'submitted', 'awarded'].includes(g.status))
        .reduce((sum, g) => {
          const amount = g.award_ceiling || g.typical_award || 0;
          return sum + (typeof amount === 'number' ? amount : 0);
        }, 0);
      
      const totalText = totalApplied > 0 ? ` - $${totalApplied.toLocaleString()} Applied` : '';
      setSubject(`Grant Pipeline Update: ${organization.name}${totalText}`);
    }
  }, [organization?.name, grants]);

  const isValid = recipient && subject && body;

  return {
    recipient,
    setRecipient,
    subject,
    setSubject,
    body,
    setBody,
    isValid,
  };
}