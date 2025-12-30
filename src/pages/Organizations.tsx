import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, Plus, Printer, Save, Sparkles } from "lucide-react"
import { base44, type Profile } from "../api/base44Client"
import { useExperience } from "../contexts/ExperienceContext"
import { Button } from "../components/ui/button"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableCaption,
} from "../components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert"
import { EmptyState } from "../components/EmptyState"
import { LoadingState } from "../components/LoadingState"
import { ErrorState } from "../components/ErrorState"
import { cn } from "../components/ui/utils"
import {
  ProfileForm,
  type ProfileFormValues,
  profilePayloadFromValues,
  toProfileFormValues,
} from "../components/organizations/ProfileForm"
import { ProfileSummary } from "../components/organizations/ProfileSummary"

export default function Organizations() {
  const queryClient = useQueryClient()
  const { markSaved, lastSavedLabel } = useExperience()
  const [notes, setNotes] = useState("")
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)

  const profilesQuery = useQuery<Profile[]>({
    queryKey: ["profiles"],
    queryFn: () => base44.profiles.list(),
  })

  const profiles = useMemo(
    () => (profilesQuery.data ?? []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [profilesQuery.data],
  )

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedProfileId((current) => {
      if (profiles.length === 0) {
        return null
      }
      if (current && profiles.some((profile) => profile.id === current)) {
        return current
      }
      return profiles[0].id
    })
  }, [profiles])

  useEffect(() => {
    const nextNotes = selectedProfile?.notes ?? ""
    if (notes === nextNotes) {
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotes(nextNotes)
  }, [notes, selectedProfile?.notes, selectedProfile?.id])

  const createProfileMutation = useMutation({
    mutationFn: async (values: ProfileFormValues) => {
      const payload = profilePayloadFromValues(values)
      const created = await base44.profiles.create(payload)
      return created
    },
    onSuccess: (profile) => {
      setIsCreateOpen(false)
      setSelectedProfileId(profile.id)
      void queryClient.invalidateQueries({ queryKey: ["profiles"] })
    },
  })

  const updateProfileMutation = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: ProfileFormValues }) => {
      const payload = profilePayloadFromValues(values)
      return base44.profiles.update(id, payload)
    },
    onSuccess: (updatedProfile) => {
      setIsEditOpen(false)
      setSelectedProfileId(updatedProfile.id)
      void queryClient.invalidateQueries({ queryKey: ["profiles"] })
    },
  })

  const saveNotesMutation = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      return base44.profiles.update(id, { notes: content })
    },
    onSuccess: (updatedProfile) => {
      setNotes(updatedProfile.notes ?? "")
      markSaved()
      void queryClient.invalidateQueries({ queryKey: ["profiles"] })
    },
  })

  const handleSave = () => {
    if (!selectedProfile) {
      markSaved()
      return
    }

    saveNotesMutation.mutate({
      id: selectedProfile.id,
      content: notes,
    })
  }

  const handlePrint = () => {
    window.print()
  }

  const handleExport = () => {
    window.print()
  }

  const handleRetry = () => {
    void queryClient.invalidateQueries({ queryKey: ["profiles"] })
  }

  if (profilesQuery.isLoading) {
    return (
      <main className="mx-auto max-w-6xl space-y-8 p-6">
        <LoadingState label="Loading organization workspace..." />
      </main>
    )
  }

  if (profilesQuery.isError) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <ErrorState onRetry={handleRetry} />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-2">
          <Badge variant="secondary" className="w-fit">Portfolio coordination</Badge>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Organizations</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Maintain partner records, capture eligibility insights, and prepare export-ready profiles for grant submissions.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button onClick={() => setIsCreateOpen(true)} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" aria-hidden />
            New profile
          </Button>
          <Button
            onClick={handleSave}
            className="w-full sm:w-auto"
            disabled={!selectedProfile || saveNotesMutation.isPending || notes === (selectedProfile.notes ?? "")}
          >
            <Save className="h-4 w-4" aria-hidden />
            {saveNotesMutation.isPending ? "Saving…" : "Save notes"}
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full sm:w-auto">
                <Download className="h-4 w-4" aria-hidden />
                Export options
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Export profiles</DialogTitle>
                <DialogDescription>Select an export format for sharing or archival.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>GrantFlow can generate several formats:</p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>PDF dossier with contact, eligibility, and latest notes</li>
                  <li>CSV spreadsheet for importing into CRMs or donor systems</li>
                  <li>Sanitized summary for external collaborators</li>
                </ul>
              </div>
              <DialogFooter className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={handleExport} className="w-full sm:w-auto">
                  Export PDF dossier
                </Button>
                <Button variant="secondary" onClick={handleExport} className="w-full sm:w-auto">
                  Export CSV snapshot
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="outline" onClick={handlePrint} className="w-full sm:w-auto">
            <Printer className="h-4 w-4" aria-hidden />
            Print workspace
          </Button>
        </div>
      </section>

      <Alert className="bg-muted/40">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <AlertTitle>Autosave ready</AlertTitle>
            <AlertDescription>Press Ctrl+S any time to log a timestamped update in your admin session.</AlertDescription>
          </div>
          <span className="text-xs text-muted-foreground">Last saved: {lastSavedLabel}</span>
        </div>
      </Alert>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card className="border-muted/70">
          <CardHeader className="flex flex-col gap-6">
            <CardTitle className="text-xl font-semibold">Workspace overview</CardTitle>
            <CardDescription>Switch between profiles and working notes for your current grant cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={profiles.length > 0 ? "profiles" : "notes"} className="space-y-5">
              <TabsList>
                <TabsTrigger value="profiles">Profiles</TabsTrigger>
                <TabsTrigger value="notes" disabled={!selectedProfile}>
                  Notes
                </TabsTrigger>
              </TabsList>

              <TabsContent value="profiles" className="mt-0 space-y-4">
                {profiles.length === 0 ? (
                  <EmptyState
                    title="No organizations yet"
                    description="Add your first organization to begin tracking conversations, eligibility, and grant history."
                    icon={<Sparkles className="h-6 w-6" aria-hidden />}
                    action={
                      <Button variant="secondary" onClick={() => setIsCreateOpen(true)}>
                        Create profile
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Notes</TableHead>
                          <TableHead className="text-right">Updated</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {profiles.map((profile) => {
                          const isSelected = profile.id === selectedProfileId
                          return (
                            <TableRow
                              key={profile.id}
                              onClick={() => setSelectedProfileId(profile.id)}
                              className={cn(
                                "cursor-pointer hover:bg-muted/40",
                                isSelected && "border-primary bg-primary/5",
                              )}
                            >
                              <TableCell className="font-medium">{profile.display_name}</TableCell>
                              <TableCell>
                                <Badge variant="secondary" className="capitalize">
                                  {profile.profile_type}
                                </Badge>
                              </TableCell>
                              <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                                {profile.notes || "—"}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">
                                {new Date(profile.updated_at).toLocaleDateString()}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                    <TableCaption className="text-xs text-muted-foreground">
                      Sorted alphabetically. Select an organization to continue personalization inside GrantFlow.
                    </TableCaption>
                  </>
                )}
              </TabsContent>

              <TabsContent value="notes" className="mt-0 space-y-4">
                <div className="space-y-3">
                  <label htmlFor="organization-notes" className="text-sm font-medium text-foreground">
                    Working notes
                  </label>
                  <textarea
                    id="organization-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Capture eligibility insights, decision makers, and follow-up items..."
                    className="h-48 w-full resize-none rounded-lg border border-muted bg-background px-4 py-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  />
                </div>
                <CardFooter className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>{notes.length} characters</span>
                  <span>Need structure? Use headings like Goals, Funding fit, Next steps.</span>
                </CardFooter>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <ProfileSummary
          profile={selectedProfile}
          onEdit={() => {
            if (selectedProfile) {
              setIsEditOpen(true)
            }
          }}
        />
      </div>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!createProfileMutation.isPending) {
            setIsCreateOpen(open)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create profile</DialogTitle>
            <DialogDescription>
              Capture key identifiers, compliance fields, and contact information for a new organization.
            </DialogDescription>
          </DialogHeader>
          {createProfileMutation.isError ? (
            <p className="text-sm text-destructive">
              {(createProfileMutation.error as Error).message ?? "Unable to create profile."}
            </p>
          ) : null}
          <ProfileForm
            initialValues={toProfileFormValues()}
            onSubmit={(values) => createProfileMutation.mutate(values)}
            onCancel={() => setIsCreateOpen(false)}
            isSubmitting={createProfileMutation.isPending}
            submitLabel="Create profile"
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={isEditOpen}
        onOpenChange={(open) => {
          if (!updateProfileMutation.isPending) {
            setIsEditOpen(open)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>
              Update ownership, eligibility notes, and compliance data to keep the portfolio current.
            </DialogDescription>
          </DialogHeader>
          {updateProfileMutation.isError ? (
            <p className="text-sm text-destructive">
              {(updateProfileMutation.error as Error).message ?? "Unable to update profile."}
            </p>
          ) : null}
          <ProfileForm
            initialValues={toProfileFormValues(selectedProfile ?? undefined)}
            onSubmit={(values) => {
              if (!selectedProfile) return
              updateProfileMutation.mutate({ id: selectedProfile.id, values })
            }}
            onCancel={() => setIsEditOpen(false)}
            isSubmitting={updateProfileMutation.isPending}
            submitLabel="Save changes"
          />
        </DialogContent>
      </Dialog>
    </main>
  )
}
