import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Plus, Search, FileText } from "lucide-react";

export default function EmptyStateCard() {
  return (
    <Card 
      className="shadow-lg border-0 border-l-4 border-l-blue-500 mt-6"
      role="region"
      aria-label="Getting started guide"
    >
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-blue-50 rounded-lg shrink-0">
            <Building2 className="w-6 h-6 text-blue-600" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-lg">Get Started</h3>
            <p className="text-slate-600 mt-1 mb-4">
              Welcome to GrantFlow! Start by adding your first organization to begin discovering and managing grants.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to={createPageUrl("Organizations")}>
                <Button className="bg-blue-600 hover:bg-blue-700" aria-label="Add your first organization">
                  <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                  Add Organization
                </Button>
              </Link>
              <Link to={createPageUrl("DiscoverGrants")}>
                <Button variant="outline" aria-label="Discover grants">
                  <Search className="w-4 h-4 mr-2" aria-hidden="true" />
                  Discover Grants
                </Button>
              </Link>
              <a 
                href="https://grantflow.help/getting-started" 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <Button variant="ghost" aria-label="View documentation">
                  <FileText className="w-4 h-4 mr-2" aria-hidden="true" />
                  View Guide
                </Button>
              </a>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}