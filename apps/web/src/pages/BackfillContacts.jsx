import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useContactBackfill } from "@/components/hooks/useContactBackfill";
import BackfillLogPanel from "@/components/backfill/BackfillLogPanel";
import BackfillStats from "@/components/backfill/BackfillStats";
import BackfillStatusBanner from "@/components/backfill/BackfillStatusBanner";

export default function BackfillContacts() {
  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === "buckeye7066@gmail.com";

  const { runBackfill, status, progress, logs, summary } = useContactBackfill({ user, isAdmin });

  if (isLoadingUser) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 p-8 text-center">
        <ShieldAlert className="h-12 w-12 text-red-500" />
        <h2 className="text-xl font-bold text-red-600">Access Denied</h2>
        <p className="mt-2 text-slate-600">This tool is restricted to administrators only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>Contact Method Backfill</CardTitle>
          <CardDescription>
            This tool migrates legacy email and phone data from the Organization table to the new
            ContactMethod table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            <Button onClick={runBackfill} disabled={status === "running"}>
              {status === "running" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Running...
                </>
              ) : (
                "Start Backfill"
              )}
            </Button>

            {status !== "idle" && (
              <div className="space-y-4">
                <Progress value={progress} className="w-full" />
                <BackfillLogPanel logs={logs} />
                <BackfillStats {...summary} />
                <BackfillStatusBanner status={status} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}