import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Plus } from "lucide-react";

export default function EmptyStateCard() {
  return (
    <Card className="shadow-lg bg-card text-card-foreground border-l-4 border-l-primary mt-6">
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-primary/10 rounded-lg">
            <Building2 className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-card-foreground text-lg">Get Started</h3>
            <p className="text-muted-foreground mt-1">
              Welcome to GrantFlow! Start by adding your first organization to begin discovering and managing grants.
            </p>
            <Link to={createPageUrl("Organizations")}>
              <Button className="mt-4" aria-label="Add your first organization">
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