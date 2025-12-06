import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, User } from 'lucide-react';

/**
 * Profile selection and match trigger panel
 */
export default function ProfileSelectPanel({
  organizations,
  selectedOrgId,
  onSelectOrg,
  onMatch,
  isLoading,
  isMatching,
}) {
  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Select Profile to Match</CardTitle>
        <CardDescription>
          Choose an organization or individual profile to analyze grant compatibility
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Select 
              value={selectedOrgId} 
              onValueChange={onSelectOrg}
              disabled={isLoading || isMatching}
            >
              <SelectTrigger className="h-12">
                <SelectValue placeholder="Select a profile..." />
              </SelectTrigger>
              <SelectContent>
                {organizations.map(org => (
                  <SelectItem key={org.id} value={org.id}>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4" />
                      {org.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <Button
            onClick={onMatch}
            disabled={!selectedOrgId || isMatching}
            className="bg-purple-600 hover:bg-purple-700"
            size="lg"
          >
            {isMatching ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 mr-2" />
                Match Grants
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}