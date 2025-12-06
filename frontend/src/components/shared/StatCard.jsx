import React from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Reusable stat card component for displaying metrics
 * @param {string} title - Card title
 * @param {string|number} value - Card value
 * @param {React.Component} icon - Lucide icon component
 * @param {string} color - Tailwind color class
 */
export default function StatCard({ title, value, icon: Icon, color }) {
  return (
    <Card className="shadow-lg border-0">
      <CardContent className="p-6">
        <div className="flex justify-between items-start">
          <div>
            <p className={`text-sm font-medium ${color}`}>{title}</p>
            <p className="text-3xl font-bold text-slate-900 mt-2">{value}</p>
          </div>
          <div className="p-3 bg-slate-100 rounded-xl">
            <Icon className={`w-6 h-6 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}