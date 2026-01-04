import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FolderOpen, Loader2, Sparkles, UserCircle2 } from "lucide-react";
import DocumentItem from "../components/documents/DocumentItem";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { listProfiles } from "@/api/profiles";
import { listDocuments, deleteDocument } from "@/api/documents";
import { listCrawlerJobs, triggerProfileEnrichment } from "@/api/crawlers";

export default function Documents() {
  const [selectedProfileId, setSelectedProfileId] = useState(null);
  const [deletingDoc, setDeletingDoc] = useState(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: profiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => listProfiles({ status: 'active' }),
    onSuccess: (data) => {
      if (data.length > 0 && !selectedProfileId) {
        setSelectedProfileId(data[0].id);
      }
    }
  });

  const { data: documents = [], isLoading: isLoadingDocuments } = useQuery({
    queryKey: ['documents', selectedProfileId],
    queryFn: () => listDocuments({ profile_id: selectedProfileId }),
    enabled: !!selectedProfileId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', selectedProfileId] });
      setDeletingDoc(null);
    },
  });

  const enrichmentMutation = useMutation({
    mutationFn: () => triggerProfileEnrichment({ profileId: selectedProfileId }),
    onSuccess: (job) => {
      toast({
        title: "Profile enrichment queued",
        description: job?.id
          ? `Job ${job.id.slice(0, 8)}… will enrich the profile shortly.`
          : "AI enrichment will run shortly.",
      });
      queryClient.invalidateQueries({ queryKey: ['crawler-jobs'] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to queue enrichment",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      });
    },
  });

  const enrichmentJobsQuery = useQuery({
    queryKey: ['profile-enrichment-jobs', selectedProfileId],
    queryFn: () => listCrawlerJobs({ type: 'profile_enrichment', profile_id: selectedProfileId, limit: 5 }),
    enabled: !!selectedProfileId,
    refetchInterval: (query) => {
      const job = query.state.data?.[0]
      return job && job.status === 'running' ? 5000 : false
    },
  });

  const enrichmentHistory = enrichmentJobsQuery.data ?? [];
  const latestEnrichmentJob = enrichmentHistory[0] ?? null;
  const [selectedJob, setSelectedJob] = useState(null);

  const enrichmentSections = useMemo(() => {
    if (!latestEnrichmentJob?.result_meta?.sections) return []
    return latestEnrichmentJob.result_meta.sections.filter(Boolean)
  }, [latestEnrichmentJob])

  const statusToBadgeClass = (status) =>
    ({
      queued: "bg-slate-100 text-slate-700",
      running: "bg-blue-100 text-blue-700",
      completed: "bg-emerald-100 text-emerald-700",
      failed: "bg-red-100 text-red-700",
      cancelled: "bg-amber-100 text-amber-700",
    }[status ?? "queued"] ?? "bg-slate-100 text-slate-700")

  const enrichmentStatusClass = statusToBadgeClass(latestEnrichmentJob?.status)

  const enrichmentBusy = enrichmentMutation.isPending || latestEnrichmentJob?.status === "running"

  const describeTimestamp = (value) => {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return formatDistanceToNow(date, { addSuffix: true })
  }

const getJobDurationSeconds = (job) => {
  if (!job) return null
  if (typeof job.result_meta?.duration_seconds === "number") {
    return job.result_meta.duration_seconds
  }
  if (typeof job.duration_seconds === "number") {
    return job.duration_seconds
  }
  return null
}

const formatDurationSeconds = (seconds) => {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0) return null
  const totalSeconds = Math.round(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

const describeDuration = (job) => {
  const seconds = getJobDurationSeconds(job)
  if (seconds === null) return null
  return formatDurationSeconds(seconds)
}

const latestDuration = describeDuration(latestEnrichmentJob)

  const previousStatusRef = useRef(null)
  useEffect(() => {
    const status = latestEnrichmentJob?.status ?? null
    const previousStatus = previousStatusRef.current

    if (
      status &&
      status !== previousStatus &&
      (status === "completed" || status === "failed" || status === "cancelled")
    ) {
      queryClient.invalidateQueries({ queryKey: ['documents', selectedProfileId] })
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    }

    previousStatusRef.current = status
  }, [latestEnrichmentJob?.status, selectedProfileId, queryClient])

  const handleDelete = (doc) => {
    setDeletingDoc(doc);
  };

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Document Library</h1>
            <p className="text-slate-600 mt-2">
              Upload source material and let AI enrich each profile automatically.
            </p>
          </div>
          <div className="flex gap-4 items-center">
            {profiles.length > 0 && (
              <Select value={selectedProfileId ?? ''} onValueChange={setSelectedProfileId}>
                <SelectTrigger className="w-72">
                  <div className="flex items-center gap-2">
                    <UserCircle2 className="w-4 h-4 text-slate-500" />
                    <SelectValue placeholder="Select a profile..." />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {profiles.map(profile => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              onClick={() => enrichmentMutation.mutate()}
              disabled={!selectedProfileId || enrichmentBusy}
              className="gap-2"
            >
              {enrichmentBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-blue-600" />
              )}
              {enrichmentBusy ? "Enrichment running…" : "Enrich Profile"}
            </Button>
          </div>
        </div>

        {latestEnrichmentJob ? (
          <Card className="mb-6 border border-blue-100 bg-blue-50/70">
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-blue-900 flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    Most recent enrichment
                  </p>
                  <p className="text-xs text-blue-800">
                    {latestEnrichmentJob.completed_at && describeTimestamp(latestEnrichmentJob.completed_at)
                      ? `Completed ${describeTimestamp(latestEnrichmentJob.completed_at)}`
                      : latestEnrichmentJob.started_at && describeTimestamp(latestEnrichmentJob.started_at)
                      ? `Started ${describeTimestamp(latestEnrichmentJob.started_at)}`
                      : describeTimestamp(latestEnrichmentJob.created_at)
                      ? `Queued ${describeTimestamp(latestEnrichmentJob.created_at)}`
                      : "Queued"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={enrichmentStatusClass}>
                    {latestEnrichmentJob.status.replace(/_/g, " ")}
                  </Badge>
                  {latestDuration ? (
                    <span className="text-[11px] font-medium text-blue-700/80">Duration {latestDuration}</span>
                  ) : null}
                  <Button variant="outline" size="xs" onClick={() => setSelectedJob(latestEnrichmentJob)}>
                    View details
                  </Button>
                </div>
              </div>

              {enrichmentSections.length > 0 ? (
                <div className="text-xs text-blue-900 space-y-2">
                  <p className="font-medium uppercase tracking-wide text-blue-800">Updated sections</p>
                  <ul className="list-disc list-inside space-y-1">
                    {enrichmentSections.map((entry) => (
                      <li key={entry.section_key}>
                        <span className="font-semibold">
                          {entry.section_key.replace(/_/g, " ")}
                        </span>
                        {entry.updated_fields?.length
                          ? ` • ${entry.updated_fields.join(", ")}`
                          : null}
                        {entry.notes ? <span className="block text-blue-700/80">{entry.notes}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-blue-800">Awaiting enrichment details.</p>
              )}

              {latestEnrichmentJob.error ? (
                <p className="text-xs text-red-600">Error: {latestEnrichmentJob.error}</p>
              ) : null}

              {enrichmentHistory.length > 1 ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-blue-800">Recent runs</p>
                  <div className="space-y-1.5">
                    {enrichmentHistory.slice(1).map((job) => {
                      const jobDuration = describeDuration(job)
                      return (
                        <div
                          key={job.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-white/70 px-3 py-2 text-xs text-blue-900"
                        >
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-[11px] text-blue-600">{job.id.slice(0, 8)}…</span>
                            <span className="text-blue-700/80">
                              {describeTimestamp(job.completed_at) ||
                                describeTimestamp(job.started_at) ||
                                describeTimestamp(job.created_at) ||
                                "Queued"}
                            </span>
                          </div>
                          <div className="flex flex-col items-end gap-1 text-right">
                            <Badge className={statusToBadgeClass(job.status)}>{job.status.replace(/_/g, " ")}</Badge>
                            {jobDuration ? (
                              <span className="text-[11px] text-blue-700/80">Duration {jobDuration}</span>
                            ) : null}
                            {Array.isArray(job.result_meta?.sections) && job.result_meta.sections.length > 0 ? (
                              <span className="text-[11px] text-blue-700/80">
                                {job.result_meta.sections.length} section
                                {job.result_meta.sections.length === 1 ? "" : "s"} updated
                              </span>
                            ) : null}
                            {job.error ? (
                              <span className="text-[11px] text-red-600">Error: {job.error}</span>
                            ) : null}
                            <Button
                              variant="outline"
                              size="xs"
                              className="mt-1"
                              onClick={() => setSelectedJob(job)}
                            >
                              View details
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card className="shadow-lg border-0">
          <CardHeader>
            <CardTitle>
              {selectedProfile?.display_name ?? 'All Profiles'} Documents ({documents.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingDocuments ? (
              <div className="flex justify-center items-center py-16">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <FolderOpen className="w-16 h-16 mx-auto mb-4 text-slate-300" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No Documents Yet</h3>
                {!selectedProfileId ? (
                  <p>Select a profile to view or add documents.</p>
                ) : (
                  <p className="mb-4">No documents available for this profile.</p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {documents.map(doc => (
                  <DocumentItem key={doc.id} document={doc} onDelete={handleDelete} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={!!deletingDoc} onOpenChange={() => setDeletingDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the document "{deletingDoc?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingDoc && deleteMutation.mutate(deletingDoc.id)}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(selectedJob)} onOpenChange={(open) => !open && setSelectedJob(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex flex-col gap-1">
              <span>Enrichment job details</span>
              {selectedJob ? (
                <span className="font-mono text-xs text-slate-500">{selectedJob.id}</span>
              ) : null}
            </DialogTitle>
          </DialogHeader>
          {selectedJob ? (
            <div className="space-y-4 text-sm text-slate-700">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
                  <Badge className={statusToBadgeClass(selectedJob.status)}>{selectedJob.status.replace(/_/g, " ")}</Badge>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Created</p>
                  <p className="text-xs text-slate-600">
                    {describeTimestamp(selectedJob.created_at) ?? selectedJob.created_at ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Started</p>
                  <p className="text-xs text-slate-600">
                    {describeTimestamp(selectedJob.started_at) ?? selectedJob.started_at ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Completed</p>
                  <p className="text-xs text-slate-600">
                    {describeTimestamp(selectedJob.completed_at) ?? selectedJob.completed_at ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Duration</p>
                  <p className="text-xs text-slate-600">
                    {describeDuration(selectedJob) ?? "—"}
                  </p>
                </div>
              </div>

              {Array.isArray(selectedJob.result_meta?.sections) && selectedJob.result_meta.sections.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Updated sections</p>
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2 text-xs text-slate-700">
                    {selectedJob.result_meta.sections.map((entry) => (
                      <div key={entry.section_key}>
                        <p className="font-semibold">{entry.section_key.replace(/_/g, " ")}</p>
                        {entry.updated_fields?.length ? (
                          <p className="text-slate-600">
                            Fields: <span className="text-slate-800">{entry.updated_fields.join(", ")}</span>
                          </p>
                        ) : null}
                        {entry.notes ? <p className="text-slate-600">Notes: {entry.notes}</p> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Parameters</p>
                <ScrollArea className="max-h-48 rounded-md border border-slate-200 bg-slate-50 p-2">
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap">
                    {JSON.stringify(selectedJob.parameters ?? {}, null, 2)}
                  </pre>
                </ScrollArea>
              </div>

              {selectedJob.result_meta ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Result meta</p>
                  <ScrollArea className="max-h-48 rounded-md border border-slate-200 bg-slate-50 p-2">
                    <pre className="text-xs text-slate-700 whitespace-pre-wrap">
                      {JSON.stringify(selectedJob.result_meta, null, 2)}
                    </pre>
                  </ScrollArea>
                </div>
              ) : null}

              {selectedJob.error ? (
                <p className="text-xs text-red-600">Error: {selectedJob.error}</p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}