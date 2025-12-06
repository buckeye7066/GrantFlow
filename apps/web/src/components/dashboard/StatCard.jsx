import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";

/** Safe value display - handles undefined/null/NaN */
const formatValue = (val) => {
  if (val === null || val === undefined) return '0';
  if (typeof val === 'number' && Number.isNaN(val)) return '0';
  return val;
};

export default function StatCard({ title = 'Stat', value, icon: Icon, color = 'from-slate-500 to-slate-600', link }) {
  const CardWrapper = link ? Link : 'div';
  const wrapperProps = link ? { to: link } : {};
  const displayValue = formatValue(value);

  return (
    <CardWrapper {...wrapperProps}>
      <Card 
        className={`relative overflow-hidden hover:shadow-xl transition-all duration-300 border-0 bg-white ${link ? 'cursor-pointer' : ''}`}
        role="article"
        aria-label={`${title}: ${displayValue}`}
      >
        <div className={`absolute inset-0 bg-gradient-to-br ${color} opacity-5`} aria-hidden="true" />
        <CardContent className="p-6">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm font-medium text-slate-600">{title}</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">{displayValue}</p>
            </div>
            {Icon && (
              <div className={`p-3 rounded-xl bg-gradient-to-br ${color} shadow-lg`}>
                <Icon className="w-6 h-6 text-white" aria-hidden="true" />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </CardWrapper>
  );
}