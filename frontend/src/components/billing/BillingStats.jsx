import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, FileText, Clock, Receipt } from "lucide-react";

/**
 * Billing statistics cards
 */
export default function BillingStats({ activeProjectsCount, unbilledAmount, totalAR, overdueCount }) {
  const stats = [
    {
      title: "Active Projects",
      value: activeProjectsCount,
      icon: FileText,
      color: "text-blue-600",
      bgColor: "bg-blue-50"
    },
    {
      title: "Unbilled Time",
      value: `$${unbilledAmount.toLocaleString()}`,
      icon: Clock,
      color: "text-amber-600",
      bgColor: "bg-amber-50"
    },
    {
      title: "Accounts Receivable",
      value: `$${totalAR.toLocaleString()}`,
      icon: DollarSign,
      color: "text-emerald-600",
      bgColor: "bg-emerald-50"
    },
    {
      title: "Overdue Invoices",
      value: overdueCount,
      icon: Receipt,
      color: overdueCount > 0 ? "text-red-600" : "text-slate-600",
      bgColor: overdueCount > 0 ? "bg-red-50" : "bg-slate-50"
    }
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
      {stats.map(stat => (
        <Card key={stat.title} className="border-0 shadow-lg">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm text-slate-600">{stat.title}</p>
                <p className={`text-3xl font-bold mt-2 ${stat.color}`}>
                  {stat.value}
                </p>
              </div>
              <div className={`p-3 ${stat.bgColor} rounded-xl`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}