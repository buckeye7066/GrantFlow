import React from "react";
import { Card, CardContent, CardHeader, CardFooter } from "@/components/ui/card";

/**
 * Skeleton loading card component
 */
export function SkeletonCard() {
  return (
    <Card className="shadow-lg border-0 animate-pulse">
      <CardContent className="p-6">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="h-4 bg-slate-200 rounded w-24 mb-3"></div>
            <div className="h-8 bg-slate-200 rounded w-32"></div>
          </div>
          <div className="w-12 h-12 bg-slate-200 rounded-xl"></div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Skeleton loading for grant cards
 */
export function SkeletonGrantCard() {
  return (
    <Card className="animate-pulse">
      <CardHeader>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-5 h-5 bg-slate-200 rounded"></div>
          <div className="h-5 bg-slate-200 rounded w-3/4"></div>
        </div>
        <div className="h-4 bg-slate-200 rounded w-1/2"></div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between">
          <div className="h-4 bg-slate-200 rounded w-20"></div>
          <div className="h-4 bg-slate-200 rounded w-24"></div>
        </div>
        <div className="flex justify-between">
          <div className="h-4 bg-slate-200 rounded w-16"></div>
          <div className="h-4 bg-slate-200 rounded w-24"></div>
        </div>
        <div className="h-2 bg-slate-200 rounded w-full"></div>
        <div className="flex justify-between">
          <div className="h-4 bg-slate-200 rounded w-20"></div>
          <div className="h-4 bg-slate-200 rounded w-28"></div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Skeleton loading for document cards
 */
export function SkeletonDocumentCard() {
  return (
    <Card className="animate-pulse flex flex-col">
      <CardHeader className="flex-row items-center gap-4 space-y-0 pb-4">
        <div className="w-12 h-12 bg-slate-200 rounded-lg"></div>
        <div className="flex-1">
          <div className="h-4 bg-slate-200 rounded w-3/4 mb-2"></div>
          <div className="h-3 bg-slate-200 rounded w-1/2"></div>
        </div>
      </CardHeader>
      <CardContent className="flex-grow">
        <div className="h-3 bg-slate-200 rounded w-2/3"></div>
      </CardContent>
      <CardFooter className="flex gap-2">
        <div className="h-9 bg-slate-200 rounded flex-1"></div>
        <div className="h-9 w-9 bg-slate-200 rounded"></div>
      </CardFooter>
    </Card>
  );
}