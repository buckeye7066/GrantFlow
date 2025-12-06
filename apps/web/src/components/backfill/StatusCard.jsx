import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

const colorClasses = {
  blue: {
    card: 'bg-blue-50 border-blue-200',
    text: 'text-blue-900',
    subtext: 'text-blue-700'
  },
  emerald: {
    card: 'bg-emerald-50 border-emerald-200',
    text: 'text-emerald-900',
    subtext: 'text-emerald-700'
  },
  amber: {
    card: 'bg-amber-50 border-amber-200',
    text: 'text-amber-900',
    subtext: 'text-amber-700'
  }
};

/**
 * Status card for displaying count metrics
 */
export default function StatusCard({ label, count, color = 'blue' }) {
  const colors = colorClasses[color] || colorClasses.blue;

  return (
    <Card className={colors.card}>
      <CardContent className="pt-6">
        <div className="text-center">
          <div className={`text-3xl font-bold ${colors.text}`}>
            {count}
          </div>
          <div className={`text-sm ${colors.subtext} mt-1`}>
            {label}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}