import React, { useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, AlertTriangle, Plus } from "lucide-react";
import { format, isPast } from 'date-fns';

const isValidDate = (dateString) => {
    if (!dateString) return false;
    try {
        const date = new Date(dateString);
        return !Number.isNaN(date.getTime());
    } catch {
        return false;
    }
};

const formatReportDate = (dateString) => {
    if (!isValidDate(dateString)) return 'No date';
    try {
        return format(new Date(dateString), 'MMM dd, yyyy');
    } catch {
        return 'Invalid date';
    }
};

export default function ComplianceFeed({ reports = [], onViewReport, onAddReport }) {
    const upcomingReports = useMemo(() => {
        const safeReports = Array.isArray(reports) ? reports : [];
        return safeReports
            .filter(r => {
                if (r?.status === 'submitted' || r?.status === 'accepted') return false;
                return isValidDate(r?.due_date);
            })
            .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
    }, [reports]);

    const handleView = useCallback((report) => {
        if (typeof onViewReport === 'function') {
            onViewReport(report);
        }
    }, [onViewReport]);

    return (
        <Card className="shadow-lg border-0" role="region" aria-label="Compliance feed">
            <CardHeader>
                <CardTitle>Compliance Feed</CardTitle>
            </CardHeader>
            <CardContent>
                {upcomingReports.length === 0 ? (
                    <div className="text-center py-4">
                        <p className="text-sm text-slate-500 mb-3">No upcoming reports due.</p>
                        {typeof onAddReport === 'function' && (
                            <Button variant="outline" size="sm" onClick={onAddReport} className="gap-2">
                                <Plus className="w-4 h-4" />
                                Schedule Report
                            </Button>
                        )}
                    </div>
                ) : (
                    <ul className="space-y-3" role="list">
                        {upcomingReports.map(report => {
                            const key = report?.id || `report-${report?.report_type || Math.random()}`;
                            const reportType = report?.report_type || 'Unknown';
                            const title = report?.title || `${reportType} Report`;
                            const isOverdue = isValidDate(report.due_date) && isPast(new Date(report.due_date));
                            
                            return (
                                <li
                                    key={key}
                                    role="listitem"
                                    aria-label={`${title}, due ${formatReportDate(report.due_date)}${isOverdue ? ', overdue' : ''}`}
                                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg"
                                >
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        {isOverdue ? (
                                            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" aria-hidden="true" />
                                        ) : (
                                            <FileText className="w-5 h-5 text-slate-500 shrink-0" aria-hidden="true" />
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-900 truncate">{title}</p>
                                            <p className={`text-sm ${isOverdue ? 'text-red-600 font-medium' : 'text-slate-600'}`}>
                                                {isOverdue && 'Overdue: '}Due: {formatReportDate(report.due_date)}
                                            </p>
                                        </div>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleView(report)}
                                        aria-label={`View ${title}`}
                                    >
                                        View
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}