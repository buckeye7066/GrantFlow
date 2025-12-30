import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Lightbulb, ThumbsUp, ThumbsDown, Sparkles, Loader2, Wand2 } from 'lucide-react';

export default function CoachFeedback({ feedback, onImprove, isImproving }) {
    if (!feedback) {
        return (
            <Card className="bg-slate-50 border-slate-200">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Lightbulb className="w-5 h-5 text-blue-600" />
                        AI Coach
                    </CardTitle>
                    <CardDescription>
                        Click "Get AI Coach Feedback" above to analyze this section.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    const feedbackSections = [
        { title: 'Strengths', icon: ThumbsUp, items: feedback.strengths, color: 'text-emerald-600', bg: 'bg-emerald-50' },
        { title: 'Areas for Improvement', icon: ThumbsDown, items: feedback.weaknesses, color: 'text-amber-600', bg: 'bg-amber-50', improvable: true },
        { title: 'Actionable Suggestions', icon: Sparkles, items: feedback.suggestions, color: 'text-blue-600', bg: 'bg-blue-50', improvable: true },
    ];

    return (
        <Card className="bg-slate-50 border-slate-200 shadow-inner">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Lightbulb className="w-5 h-5 text-blue-600" />
                    AI Coach Feedback
                </CardTitle>
                 <CardDescription>
                    Review the AI's analysis of your draft. Use "Improve with AI" to automatically apply suggestions.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {feedbackSections.map(section => section.items && section.items.length > 0 && (
                    <div key={section.title}>
                        <h4 className={`flex items-center gap-2 font-semibold mb-3 ${section.color}`}>
                            <section.icon className="w-5 h-5" />
                            {section.title}
                        </h4>
                        <ul className="space-y-3">
                            {section.items.map((item, index) => (
                                <li key={index} className={`p-3 rounded-lg border flex justify-between items-start gap-3 ${section.bg}`}>
                                    <p className="text-sm text-slate-800 flex-1 pt-1">{item}</p>
                                    {section.improvable && onImprove && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="bg-white"
                                            onClick={() => onImprove(item)}
                                            disabled={!!isImproving}
                                        >
                                            {isImproving === item ? (
                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            ) : (
                                                <Wand2 className="w-4 h-4 mr-2" />
                                            )}
                                            Improve with AI
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}