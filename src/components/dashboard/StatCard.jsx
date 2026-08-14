import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";

export default function StatCard({ title, value, icon: Icon, color, link }) {
  const CardWrapper = link ? Link : 'div';
  const wrapperProps = link ? { to: link } : {};
  const displayValue = typeof value === 'number' ? value.toLocaleString() : (value ?? '—');

  return (
    <CardWrapper {...wrapperProps}>
      <Card className={`relative overflow-hidden hover:shadow-xl transition-all duration-300 bg-card text-card-foreground ${link ? 'cursor-pointer' : ''}`}>
        <div className={`absolute inset-0 bg-gradient-to-br ${color} opacity-10 dark:opacity-15`} />
        <CardContent className="p-6">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{title}</p>
              <p className="text-3xl font-bold text-card-foreground mt-2">{displayValue}</p>
            </div>
            <div className={`p-3 rounded-xl bg-gradient-to-br ${color} shadow-lg`}>
              {Icon && <Icon className="w-6 h-6 text-white" />}
            </div>
          </div>
        </CardContent>
      </Card>
    </CardWrapper>
  );
}