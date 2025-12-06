import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import ReactMarkdown from 'react-markdown';

/**
 * Financial summary section with budget breakdown
 */
export default function FinancialSection({ financialData }) {
  if (!financialData) return null;

  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>Financial Summary</CardTitle>
        <CardDescription>Budget and spending overview</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-3 gap-4">
          <div className="p-4 bg-blue-50 rounded-lg">
            <p className="text-xs text-blue-600 font-medium">Total Budget</p>
            <p className="text-2xl font-bold text-blue-900">
              ${financialData.total_budget?.toLocaleString() || 0}
            </p>
          </div>
          <div className="p-4 bg-amber-50 rounded-lg">
            <p className="text-xs text-amber-600 font-medium">Total Spent</p>
            <p className="text-2xl font-bold text-amber-900">
              ${financialData.total_spent?.toLocaleString() || 0}
            </p>
          </div>
          <div className="p-4 bg-emerald-50 rounded-lg">
            <p className="text-xs text-emerald-600 font-medium">Remaining</p>
            <p className="text-2xl font-bold text-emerald-900">
              ${financialData.remaining_budget?.toLocaleString() || 0}
            </p>
          </div>
        </div>
        {financialData.financial_narrative && (
          <div className="prose max-w-none">
            <ReactMarkdown>{financialData.financial_narrative}</ReactMarkdown>
          </div>
        )}
      </CardContent>
    </Card>
  );
}