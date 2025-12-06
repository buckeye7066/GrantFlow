import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import EditableMarkdown from './EditableMarkdown';

/**
 * Next steps section
 */
export default function NextStepsSection({ 
  value, 
  onChange, 
  isDraft 
}) {
  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Next Steps</CardTitle>
        <CardDescription>Plans for the upcoming period</CardDescription>
      </CardHeader>
      <CardContent>
        <EditableMarkdown
          value={value}
          onChange={onChange}
          isDraft={isDraft}
          rows={6}
          placeholder="Outline next steps and plans..."
        />
      </CardContent>
    </Card>
  );
}