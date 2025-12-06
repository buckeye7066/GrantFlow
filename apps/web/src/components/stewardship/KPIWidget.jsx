import React from 'react';
import { Card, CardContent } from "@/components/ui/card";

export default function KPIWidget({ icon: Icon, title, value, colorClass = 'bg-slate-100 text-slate-700' }) {
    const testId = `kpi-widget-${title.toLowerCase().replace(/\s+/g, '-')}`;
    
    return (
        <Card className="shadow-sm border-0" data-testid={testId} aria-label={`${title}: ${value}`}>
            <CardContent className="p-4 flex items-center gap-4">
                <div className={`p-3 rounded-lg ${colorClass}`} aria-hidden="true">
                    <Icon className="w-6 h-6" />
                </div>
                <div>
                    <p className="text-sm font-medium text-slate-500">{title}</p>
                    <p className="text-2xl font-bold text-slate-900">{value}</p>
                </div>
            </CardContent>
        </Card>
    );
}