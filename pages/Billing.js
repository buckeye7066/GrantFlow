import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Loader2 } from "lucide-react";
import BillingStats from "../components/billing/BillingStats";
import { useBillingData } from "../components/hooks/useBillingData";

export default function Billing() {
  const [selectedOrgId, setSelectedOrgId] = useState("");

  const { data: user, isLoading: isLoadingUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const { organizations, isLoading } = useBillingData(selectedOrgId);

  if (isLoadingUser || isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-slate-900 mb-8">Billing & Invoicing</h1>
        {!selectedOrgId ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <p className="text-slate-600">Select a profile to view billing information</p>
            </CardContent>
          </Card>
        ) : (
          <BillingStats />
        )}
      </div>
    </div>
  );
}