import type { Profile } from "../../api/base44Client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { EmptyState } from "../EmptyState"

interface ProfileSummaryProps {
  profile: Profile | null
  onEdit: () => void
}

export function ProfileSummary({ profile, onEdit }: ProfileSummaryProps) {
  if (!profile) {
    return (
      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle>Profile details</CardTitle>
          <CardDescription>Select an organization from the list to view details.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No profile selected"
            description="Choose an organization on the left to review eligibility, contacts, and compliance notes."
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-muted/70">
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <Badge variant="secondary" className="capitalize">
            {profile.profile_type}
          </Badge>
          <CardTitle>{profile.display_name}</CardTitle>
          <CardDescription>{profile.mission_statement || "Mission statement not captured yet."}</CardDescription>
        </div>
        <Button variant="outline" onClick={onEdit}>
          Edit profile
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <InfoBlock label="Primary contact" value={profile.full_name || "—"} />
          <InfoBlock label="Job title" value={profile.job_title || "—"} />
          <InfoBlock label="Email" value={profile.contact_email || "—"} />
          <InfoBlock label="Phone" value={profile.contact_phone || "—"} />
          <InfoBlock label="Website" value={profile.website || "—"} />
          <InfoBlock label="Last contacted" value={profile.last_contacted_at || "Not recorded"} />
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Organization</h4>
          <div className="grid gap-4 md:grid-cols-2">
            <InfoBlock label="Service area" value={profile.service_area || "—"} />
            <InfoBlock label="Demographics served" value={profile.demographics_served || "—"} />
            <InfoBlock label="Focus areas" value={profile.program_focus_areas || "—"} />
            <InfoBlock
              label="Annual budget"
              value={profile.annual_budget != null ? `$${profile.annual_budget.toLocaleString()}` : "—"}
            />
            <InfoBlock
              label="Staff count"
              value={profile.staff_count != null ? profile.staff_count.toLocaleString() : "—"}
            />
            <InfoBlock
              label="Volunteer count"
              value={profile.volunteer_count != null ? profile.volunteer_count.toLocaleString() : "—"}
            />
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Compliance & RLS</h4>
          <div className="grid gap-4 md:grid-cols-2">
            <InfoBlock label="EIN" value={profile.ein || "—"} />
            <InfoBlock label="DUNS" value={profile.duns || "—"} />
            <InfoBlock label="CAGE code" value={profile.cage_code || "—"} />
            <InfoBlock label="NAICS codes" value={profile.naics_codes || "—"} />
            <InfoBlock label="PHI required" value={profile.phi_access_required ? "Yes" : "No"} />
            <InfoBlock label="Role assignment" value={profile.owner_id || profile.case_manager_id || profile.admin_id ? "Assigned" : "Unassigned"} />
          </div>
          <InfoBlock label="Certifications" value={profile.certifications || "—"} />
          <InfoBlock label="Compliance notes" value={profile.compliance_notes || "—"} />
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Internal notes</h4>
          <p className="rounded-lg border border-muted/60 bg-muted/20 p-3 text-sm text-muted-foreground">
            {profile.notes || "No notes captured yet."}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 rounded-lg border border-muted/40 bg-muted/10 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  )
}


