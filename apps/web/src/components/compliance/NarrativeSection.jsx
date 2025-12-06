import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import EditableMarkdown from './EditableMarkdown';

/**
 * Executive summary narrative section
 */
export default function NarrativeSection({ 
  value, 
  onChange, 
  isDraft 
}) {
  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Executive Summary</CardTitle>
        <CardDescription>High-level overview of the reporting period</CardDescription>
      </CardHeader>
      <CardContent>
        <EditableMarkdown
          value={value}
          onChange={onChange}
          isDraft={isDraft}
          rows={8}
          placeholder="Enter executive summary..."
        />
      </CardContent>
    </Card>
  );
}