import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import EditableMarkdown from './EditableMarkdown';

/**
 * Activities summary section
 */
export default function ActivitiesSection({ 
  value, 
  onChange, 
  isDraft 
}) {
  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Activities Summary</CardTitle>
        <CardDescription>Detailed activities during the reporting period</CardDescription>
      </CardHeader>
      <CardContent>
        <EditableMarkdown
          value={value}
          onChange={onChange}
          isDraft={isDraft}
          rows={10}
          placeholder="Describe activities and accomplishments..."
        />
      </CardContent>
    </Card>
  );
}