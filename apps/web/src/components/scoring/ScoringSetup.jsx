import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Sparkles, AlertCircle, Info } from 'lucide-react';

/**
 * Setup form for grant scoring
 */
export default function ScoringSetup({
  grants,
  selectedGrantId,
  onGrantSelect,
  proposalText,
  onProposalChange,
  onScore,
  isScoring,
  error
}) {
  const eligibleGrants = grants.filter(g => ['interested', 'drafting', 'application_prep', 'revision'].includes(g.status));

  return (
    <Card className="shadow-xl border-0">
      <CardHeader>
        <CardTitle>Scoring Setup</CardTitle>
        <CardDescription>Select a grant from your pipeline and paste your proposal draft to begin.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div>
          <Label htmlFor="grant-select" className="text-base font-medium">Grant Opportunity</Label>
          <Select value={selectedGrantId} onValueChange={onGrantSelect}>
            <SelectTrigger id="grant-select" className="text-base h-14 mt-2">
              <SelectValue placeholder="Select a grant from your pipeline..." />
            </SelectTrigger>
            <SelectContent>
              {eligibleGrants.length === 0 ? (
                <SelectItem value="no-grants" disabled>
                  No grants available for scoring
                </SelectItem>
              ) : (
                eligibleGrants.map(grant => (
                  <SelectItem key={grant.id} value={grant.id}>
                    {grant.title}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {eligibleGrants.length === 0 && (
            <Alert className="mt-3">
              <Info className="h-4 w-4" />
              <AlertDescription>
                No grants in drafting stage. Mark a grant as "Interested" or "Drafting" in your pipeline to score it here.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div>
          <Label htmlFor="proposal-text" className="text-base font-medium">Proposal Draft</Label>
          <Textarea
            id="proposal-text"
            value={proposalText}
            onChange={(e) => onProposalChange(e.target.value)}
            placeholder="Paste your full proposal draft here..."
            className="min-h-[300px] text-base mt-2"
            disabled={isScoring}
          />
          <p className="text-xs text-slate-500 mt-2">
            Minimum 50 characters required. The AI will analyze your draft against the grant's requirements.
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={onScore}
            disabled={isScoring || !selectedGrantId || !proposalText || proposalText.length < 50}
            className="bg-purple-600 hover:bg-purple-700"
            size="lg"
          >
            {isScoring ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Scoring...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-5 w-5" />
                Score My Proposal
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}