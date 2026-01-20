import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Plus } from "lucide-react";

export default function EmptyStateCard() {
  return (
    <Card className="shadow-lg border-0 border-l-4 border-l-blue-500 mt-6">
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-blue-50 rounded-lg">
            <Building2 className="w-6 h-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-lg">Get Started</h3>
            <p className="text-slate-600 mt-1">
              Welcome to GrantFlow! Start by adding your first organization to begin discovering and managing grants.
            </p>
            <Link to={createPageUrl("Organizations")}>
              <Button className="mt-4 bg-blue-600 hover:bg-blue-700" aria-label="Add your first organization">
                <Plus className="w-4 h-4 mr-2" />
                Add Organization
              </Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}