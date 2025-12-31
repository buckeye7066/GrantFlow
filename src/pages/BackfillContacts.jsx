import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';

export default function BackfillContacts() {
  const [state, setState] = useState({
    status: 'idle', // idle, running, done, error
    progress: 0,
    logs: [],
    summary: { processed: 0, created: 0, skipped: 0, errors: 0 },
  });

  const log = (message) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, message] }));
  };

  const handleBackfill = async () => {
    setState({ status: 'running', progress: 0, logs: [], summary: { processed: 0, created: 0, skipped: 0, errors: 0 } });

    try {
      log('Starting backfill process...');
      log('Fetching all organizations...');
      const organizations = await base44.entities.Organization.list();
      log(`Found ${organizations.length} organizations.`);

      log('Fetching all existing contact methods to prevent duplicates...');
      const existingContacts = await base44.entities.ContactMethod.list();
      const existingSet = new Set(existingContacts.map(c => `${c.organization_id}-${c.type}-${c.value.trim().toLowerCase()}`));
      log(`Found ${existingContacts.length} existing contact methods.`);

      const newContactMethods = [];
      let processedCount = 0;

      for (const org of organizations) {
        const legacyEmails = org.email || [];
        const legacyPhones = org.phone || [];

        const allLegacy = [...legacyEmails.map(e => ({ type: 'email', value: e })), ...legacyPhones.map(p => ({ type: 'phone', value: p }))];

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
                setState(prev => ({ ...prev, summary: { ...prev.summary, skipped: prev.summary.skipped + 1 } }));
            } else {
                newContactMethods.push({
                    organization_id: org.id,
                    type: contact.type,
                    value: contact.value.trim(),
                    is_primary: false, // Cannot determine primary from legacy data
                    created_by: org.created_by,
                });
                log(`  - Staged new ${contact.type}: ${contact.value}`);
                existingSet.add(checkKey); // Add to set to handle duplicates within the same org
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
        setState(prev => ({ ...prev, summary: { ...prev.summary, created: newContactMethods.length } }));
        log('Bulk creation successful.');
      } else {
        log('No new contact methods to create.');
      }

      setState(prev => ({ ...prev, status: 'done', progress: 100 }));
      log('Backfill process completed successfully!');

    } catch (error) {
      console.error("Backfill failed:", error);
      log(`ERROR: ${error.message}`);
      setState(prev => ({ ...prev, status: 'error' }));
    }
  };

  const { status, progress, logs, summary } = state;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Contact Method Backfill</CardTitle>
          <CardDescription>
            This tool migrates legacy email and phone data from the Organization table to the new ContactMethod table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            <Button onClick={handleBackfill} disabled={status === 'running'}>
              {status === 'running' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : 'Start Backfill'}
            </Button>

            {status !== 'idle' && (
              <div className="space-y-4">
                <Progress value={progress} className="w-full" />
                
                <div className="p-4 bg-slate-900 text-white rounded-md font-mono text-sm h-64 overflow-y-auto">
                  {logs.map((log, index) => (
                    <p key={index} className={log.startsWith('ERROR') ? 'text-red-400' : ''}>{log}</p>
                  ))}
                </div>

                <div className="grid grid-cols-4 gap-4 text-center">
                    <div><p className="font-bold text-lg">{summary.processed}</p><p className="text-sm text-slate-500">Processed</p></div>
                    <div><p className="font-bold text-lg text-green-600">{summary.created}</p><p className="text-sm text-slate-500">Created</p></div>
                    <div><p className="font-bold text-lg text-yellow-600">{summary.skipped}</p><p className="text-sm text-slate-500">Skipped</p></div>
                    <div><p className="font-bold text-lg text-red-600">{summary.errors}</p><p className="text-sm text-slate-500">Errors</p></div>
                </div>

                {status === 'done' && (
                  <div className="flex items-center gap-2 p-4 bg-green-50 text-green-800 rounded-md">
                    <CheckCircle className="w-5 h-5" />
                    <p>Backfill completed successfully!</p>
                  </div>
                )}
                {status === 'error' && (
                  <div className="flex items-center gap-2 p-4 bg-red-50 text-red-800 rounded-md">
                    <AlertTriangle className="w-5 h-5" />
                    <p>The backfill process encountered an error. Check the logs for details.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}