import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listProfiles } from "@/api/profiles";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Loader2, 
  AlertCircle, 
  Search,
  Plus,
  Building2
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import ProfileCard from "@/components/profiles/ProfileCard";
import { createPageUrl } from "@/utils";

export default function MyProfiles() {
  const [searchTerm, setSearchTerm] = useState("");
  const navigate = useNavigate();
  
  // Fetch profiles with summary data
  const { 
    data: profiles = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: ['profiles', 'summary'],
    queryFn: () => listProfiles({ summary: true }),
  });
  
  // Filter profiles
  const filteredProfiles = useMemo(() => {
    if (!searchTerm) return profiles;
    
    const search = searchTerm.toLowerCase();
    return profiles.filter(profile => 
      profile.display_name?.toLowerCase().includes(search) ||
      profile.primary_type?.toLowerCase().includes(search) ||
      profile.organization_name?.toLowerCase().includes(search)
    );
  }, [profiles, searchTerm]);
  
  const handleViewInvoices = (profile) => {
    navigate(createPageUrl("CreateInvoice", { organization_id: profile.organization_id, profile_id: profile.id }));
  };
  
  const handleCreateProfile = () => {
    navigate(createPageUrl("Organizations"));
  };
  
  // Loading state
  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }
  
  // Error state
  if (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return (
      <div className="p-6 md:p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load profiles. Please try refreshing the page.
            {errorMessage && <span className="block mt-2 text-sm">{errorMessage}</span>}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  
  return (
    <section className="p-6 md:p-8" aria-label="My Profiles">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">My Profiles</h1>
            <p className="text-slate-600 mt-2">
              View and manage your profiles with billing and funding information
            </p>
          </div>
          <Button 
            onClick={handleCreateProfile}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Profile
          </Button>
        </header>
        
        {/* Search */}
        <div className="mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
            <Input
              type="text"
              placeholder="Search profiles..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        
        {/* Results */}
        {filteredProfiles.length === 0 ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {profiles.length === 0 ? "No Profiles Yet" : "No Matching Profiles"}
              </h3>
              <p className="text-slate-600 mb-6">
                {profiles.length === 0 
                  ? "Get started by creating your first profile to track grants and billing."
                  : "Try adjusting your search to find what you're looking for."}
              </p>
              {profiles.length === 0 && (
                <Button onClick={handleCreateProfile}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Your First Profile
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredProfiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onViewInvoices={handleViewInvoices}
                />
              ))}
            </div>
            
            <footer className="mt-6 text-center text-sm text-slate-500">
              Showing {filteredProfiles.length} of {profiles.length} profiles
            </footer>
          </>
        )}
      </div>
    </section>
  );
}
