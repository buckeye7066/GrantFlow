import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckSquare } from "lucide-react";
import { format, isPast } from 'date-fns';

export default function UpcomingMilestones({ milestones }) {
    // Helper to validate date
    const isValidDate = (dateString) => {
        if (!dateString) return false;
        const date = new Date(dateString);
        return !isNaN(date.getTime());
    };

    const upcomingMilestones = milestones
        .filter(m => !m.completed && isValidDate(m.due_date))
        .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
        .slice(0, 5);

    return (
        <Card className="shadow-lg border-0">
            <CardHeader>
                <CardTitle>Upcoming Milestones</CardTitle>
            </CardHeader>
            <CardContent>
                {upcomingMilestones.length === 0 ? (
                    <p className="text-sm text-slate-500">No upcoming milestones.</p>
                ) : (
                    <ul className="space-y-3">
                        {upcomingMilestones.map(milestone => {
                            const isOverdue = isPast(new Date(milestone.due_date));
                            return (
                                <li key={milestone.id} className="flex items-center gap-3">
                                    <CheckSquare className="w-5 h-5 text-blue-500" />
                                    <div>
                                        <p className="font-medium text-slate-900">{milestone.title}</p>
                                        <p className={`text-sm ${isOverdue ? 'text-red-600' : 'text-slate-600'}`}>
                                            {format(new Date(milestone.due_date), 'MMM dd, yyyy')}
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