import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import EditableMarkdown from './EditableMarkdown';

/**
 * Challenges and solutions section
 */
export default function ChallengesSection({ 
  value, 
  onChange, 
  isDraft 
}) {
  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Challenges & Solutions</CardTitle>
        <CardDescription>Problems encountered and how they were addressed</CardDescription>
      </CardHeader>
      <CardContent>
        <EditableMarkdown
          value={value}
          onChange={onChange}
          isDraft={isDraft}
          rows={6}
          placeholder="Describe challenges and solutions..."
        />
      </CardContent>
    </Card>
  );
}