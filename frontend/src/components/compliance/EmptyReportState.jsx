import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2 } from 'lucide-react';

/**
 * Empty state for report that hasn't been generated yet
 */
export default function EmptyReportState({ 
  reportType, 
  isGenerating, 
  onGenerate 
}) {
  return (
    <Card className="shadow-lg border-0 border-l-4 border-l-purple-500">
      <CardContent className="p-12 text-center">
        <Sparkles className="w-16 h-16 mx-auto text-purple-500 mb-4" />
        <h3 className="text-xl font-semibold text-slate-900 mb-2">
          Ready to Generate Report
        </h3>
        <p className="text-slate-600 mb-6 max-w-md mx-auto">
          Click "Generate with AI" to automatically create your {reportType} report based on 
          your grant data, budget, activities, and progress.
        </p>
        <Button 
          onClick={onGenerate}
          disabled={isGenerating}
          size="lg"
          className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Generating Report...
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5 mr-2" />
              Generate Report with AI
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}