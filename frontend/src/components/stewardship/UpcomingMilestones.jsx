import React, { useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckSquare, AlertTriangle, Plus } from "lucide-react";
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

const formatMilestoneDate = (dateString) => {
    if (!isValidDate(dateString)) return 'No date';
    try {
        return format(new Date(dateString), 'MMM dd, yyyy');
    } catch {
        return 'Invalid date';
    }
};

export default function UpcomingMilestones({ milestones = [], onMilestoneClick, onAddMilestone }) {
    const upcomingMilestones = useMemo(() => {
        const safeMilestones = Array.isArray(milestones) ? milestones : [];
        return safeMilestones
            .filter(m => !m?.completed && isValidDate(m?.due_date))
            .sort((a, b) => {
                const dateCompare = new Date(a.due_date) - new Date(b.due_date);
                if (dateCompare !== 0) return dateCompare;
                return (a.title || '').localeCompare(b.title || '');
            })
            .slice(0, 5);
    }, [milestones]);

    const handleClick = useCallback((milestone) => {
        if (typeof onMilestoneClick === 'function') {
            onMilestoneClick(milestone);
        }
    }, [onMilestoneClick]);

    const isClickable = typeof onMilestoneClick === 'function';

    return (
        <Card className="shadow-lg border-0" role="region" aria-label="Upcoming milestones">
            <CardHeader>
                <CardTitle>Upcoming Milestones</CardTitle>
            </CardHeader>
            <CardContent>
                {upcomingMilestones.length === 0 ? (
                    <div className="text-center py-4">
                        <p className="text-sm text-slate-500 mb-3">No upcoming milestones.</p>
                        {typeof onAddMilestone === 'function' && (
                            <Button variant="outline" size="sm" onClick={onAddMilestone} className="gap-2">
                                <Plus className="w-4 h-4" />
                                Add Milestone
                            </Button>
                        )}
                    </div>
                ) : (
                    <ul className="space-y-3" role="list">
                        {upcomingMilestones.map(milestone => {
                            const key = milestone?.id || `milestone-${milestone?.title || Math.random()}`;
                            const title = milestone?.title || 'Untitled Milestone';
                            const isOverdue = isValidDate(milestone.due_date) && isPast(new Date(milestone.due_date));
                            return (
                                <li 
                                    key={key}
                                    role="listitem"
                                    aria-label={`${title}, due ${formatMilestoneDate(milestone.due_date)}${isOverdue ? ', overdue' : ''}`}
                                    className={`flex items-center gap-3 ${isClickable ? 'cursor-pointer hover:bg-slate-50 p-2 rounded-lg -m-2' : ''}`}
                                    onClick={() => handleClick(milestone)}
                                    data-testid={`milestone-item-${milestone?.id || 'unknown'}`}
                                >
                                    {isOverdue ? (
                                        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" aria-hidden="true" />
                                    ) : (
                                        <CheckSquare className="w-5 h-5 text-blue-500 shrink-0" aria-hidden="true" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium text-slate-900 truncate">{title}</p>
                                        <p className={`text-sm ${isOverdue ? 'text-red-600 font-medium' : 'text-slate-600'}`}>
                                            {isOverdue && 'Overdue: '}{formatMilestoneDate(milestone.due_date)}
                                        </p>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}