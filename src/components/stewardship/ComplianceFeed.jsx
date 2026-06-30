import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { format, isPast } from 'date-fns';

export default function ComplianceFeed({ reports }) {
    // Helper to validate date
    const isValidDate = (dateString) => {
        if (!dateString) return false;
        const date = new Date(dateString);
        return !isNaN(date.getTime());
    };

    const upcomingReports = reports
        .filter(r => {
            if (r.status === 'submitted' || r.status === 'accepted') return false;
            if (!isValidDate(r.due_date)) return false;
            return true;
        })
        .sort((a, b) => {
    const da = isValidDate(a.due_date) ? new Date(a.due_date).getTime() : Infinity;
    const db = isValidDate(b.due_date) ? new Date(b.due_date).getTime() : Infinity;
    return da - db;
});

    return (
        <Card className="shadow-lg border-0">
            <CardHeader>
                <CardTitle>Compliance Feed</CardTitle>
            </CardHeader>
            <CardContent>
                {upcomingReports.length === 0 ? (
                    <p className="text-sm text-slate-500">No upcoming reports due.</p>
                ) : (
                    <ul className="space-y-3">
                        {upcomingReports.map(report => {
                            const isOverdue = isValidDate(report.due_date) && isPast(new Date(report.due_date));
                            return (
                                <li key={report.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                    <div className="flex items-center gap-3">
                                        <FileText className="w-5 h-5 text-slate-500" />
                                        <div>
                                            <p className="font-medium text-slate-900">{report.report_type} Report</p>
                                            <p className={`text-sm ${isOverdue ? 'text-red-600' : 'text-slate-600'}`}>
                                                Due: {isValidDate(report.due_date) ? format(new Date(report.due_date), 'MMM dd, yyyy') : 'Date unknown'}
                                            </p>
                                        </div>
                                    </div>
                                    <Button size="sm" variant="outline">View</Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}