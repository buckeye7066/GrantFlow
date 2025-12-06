import React from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Skeleton loader for billing page
 */
export function BillingSkeleton() {
  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header skeleton */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <div className="h-8 bg-slate-200 rounded w-64 mb-2 animate-pulse"></div>
            <div className="h-4 bg-slate-200 rounded w-96 animate-pulse"></div>
          </div>
          <div className="flex gap-3">
            <div className="h-10 w-48 bg-slate-200 rounded animate-pulse"></div>
            <div className="h-10 w-32 bg-slate-200 rounded animate-pulse"></div>
          </div>
        </div>

        {/* Banner skeleton */}
        <div className="h-24 bg-slate-200 rounded mb-6 animate-pulse"></div>

        {/* Stats skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="border-0 shadow-lg animate-pulse">
              <CardContent className="p-6">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="h-4 bg-slate-200 rounded w-24 mb-3"></div>
                    <div className="h-8 bg-slate-200 rounded w-20"></div>
                  </div>
                  <div className="w-12 h-12 bg-slate-200 rounded-xl"></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Tabs skeleton */}
        <div className="space-y-6">
          <div className="flex gap-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-10 w-24 bg-slate-200 rounded animate-pulse"></div>
            ))}
          </div>
          <Card className="shadow-lg border-0 animate-pulse">
            <CardContent className="p-12">
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-20 bg-slate-200 rounded"></div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}