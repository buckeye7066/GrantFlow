import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Custom hook for contact method backfill process (admin-only)
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 */
export function useContactBackfill({ user, isAdmin } = {}) {
  const [state, setState] = useState({
    status: 'idle', // idle, running, done, error
    progress: 0,
    logs: [],
    summary: { processed: 0, created: 0, skipped: 0, errors: 0 },
  });

  const log = useCallback((message) => {
    setState(prev => {
      // Track errors in summary
      const isError = message.startsWith('ERROR');
      return {
        ...prev,
        logs: [...prev.logs, message],
        summary: isError 
          ? { ...prev.summary, errors: prev.summary.errors + 1 }
          : prev.summary
      };
    });
  }, []);

  const runBackfill = useCallback(async () => {
    // Enforce admin-only execution
    if (!isAdmin) {
      setState(prev => ({
        ...prev,
        status: 'error',
        logs: ['ERROR: Access denied. Admin privileges required.'],
        summary: { ...prev.summary, errors: 1 }
      }));
      return;
    }

    // Ensure user is authenticated
    if (!user?.email) {
      setState(prev => ({
        ...prev,
        status: 'error',
        logs: ['ERROR: Not authenticated.'],
        summary: { ...prev.summary, errors: 1 }
      }));
      return;
    }

    setState({ 
      status: 'running', 
      progress: 0, 
      logs: [], 
      summary: { processed: 0, created: 0, skipped: 0, errors: 0 } 
    });

    try {
      log('Starting backfill process...');
      log('Fetching all organizations...');
      const organizations = await base44.entities.Organization.list();
      log(`Found ${organizations.length} organizations.`);

      log('Fetching all existing contact methods to prevent duplicates...');
      const existingContacts = await base44.entities.ContactMethod.list();
      
      // Deduplicate existing contacts using normalized values
      const existingSet = new Set(
        existingContacts.map(c => `${c.organization_id}-${c.type}-${c.value.trim().toLowerCase()}`)
      );
      log(`Found ${existingContacts.length} existing contact methods.`);

      const newContactMethods = [];
      let processedCount = 0;

      for (const org of organizations) {
        const legacyEmails = org.email || [];
        const legacyPhones = org.phone || [];

        const allLegacy = [
          ...legacyEmails.map(e => ({ type: 'email', value: e })), 
          ...legacyPhones.map(p => ({ type: 'phone', value: p }))
        ];

        if (allLegacy.length > 0) {
          log(`Processing org: ${org.name} (${org.id})`);
        }

        for (const contact of allLegacy) {
          if (!contact.value || typeof contact.value !== 'string') {
            log(`  - Skipped invalid contact value: ${contact.value}`);
            continue;
          }

          const normalizedValue = contact.value.trim().toLowerCase();
          const checkKey = `${org.id}-${contact.type}-${normalizedValue}`;

          if (existingSet.has(checkKey)) {
            log(`  - Skipping duplicate ${contact.type}: ${contact.value}`);
            setState(prev => ({ 
              ...prev, 
              summary: { ...prev.summary, skipped: prev.summary.skipped + 1 } 
            }));
          } else {
            newContactMethods.push({
              organization_id: org.id,
              type: contact.type,
              value: contact.value.trim(),
              is_primary: false,
              created_by: org.created_by,
            });
            log(`  - Staged new ${contact.type}: ${contact.value}`);
            existingSet.add(checkKey); // Prevent duplicates within same batch
          }
        }
        
        processedCount++;
        setState(prev => ({
          ...prev,
          progress: (processedCount / organizations.length) * 100,
          summary: { ...prev.summary, processed: prev.summary.processed + 1 }
        }));
      }

      if (newContactMethods.length > 0) {
        log(`Creating ${newContactMethods.length} new contact methods in bulk...`);
        await base44.entities.ContactMethod.bulkCreate(newContactMethods);
        setState(prev => ({ 
          ...prev, 
          summary: { ...prev.summary, created: newContactMethods.length } 
        }));
        log('Bulk creation successful.');
      } else {
        log('No new contact methods to create.');
      }

      setState(prev => ({ ...prev, status: 'done', progress: 100 }));
      log('Backfill process completed successfully!');

    } catch (error) {
      console.error('Backfill failed:', error);
      log(`ERROR: ${error.message}`);
      setState(prev => ({ ...prev, status: 'error' }));
    }
  }, [user?.email, isAdmin, log]);

  return {
    runBackfill,
    status: state.status,
    progress: state.progress,
    logs: state.logs,
    summary: state.summary,
  };
}