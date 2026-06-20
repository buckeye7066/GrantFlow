import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import client from "@/api/client";
import { listProfiles } from "@/api/profiles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { useToast } from "@/components/ui/use-toast";
import { Sparkles, Trash2, Loader2, Filter, ExternalLink } from "lucide-react";
import HamiltonAutopilotAuthorization from "@/components/hamilton/HamiltonAutopilotAuthorization";
import { isGrantExpired } from "@/components/shared/grantUtils";
import { isRenderableUrl } from "@/lib/matchDisplayThresholds";

/**
 * HamiltonProcessing
 *
 * A focused, profile-scoped worklist for deciding what Hamilton does with
 * every funding source already in a profile's pipeline. For each source the
 * user picks exactly one of three actions:
 *
 *   • Process — hand to Hamilton Autopilot (authorize → preflight → run)
 *   • Leave   — do nothing (the safe default)
 *   • Delete  — remove the source from the pipeline
 *
 * This page intentionally reuses the existing Hamilton pieces rather than
 * inventing a parallel path:
 *   - Sources come from the same Grant entity the Kanban board shows.
 *   - "Process" opens <HamiltonAutopilotAuthorization>, which runs the real
 *     authorize → preflight-resolve → start-autopilot flow.
 *   - "Delete" calls the same Grant.delete the pipeline uses.
 *
 * It's reachable both as its own route (/HamiltonProcessing?profile_id=…,
 * which is what the "Process Funding Sources with Hamilton" button on the
 * Pipeline opens in a new tab) and from the sidebar. Because it can be opened
 * standalone, it carries its own profile selector.
 */

const ACTIONS = Object.freeze({ LEAVE: "leave", PROCESS: "process", DELETE: "delete" });

/**
 * Decide the default action for a freshly-loaded source.
 *
 * DESIGN NOTE (automation-forward default, per "Automation is King"):
 * a source defaults to PROCESS when it is Hamilton-ready — not expired and
 * carrying an actionable application URL for Hamilton to work — and to LEAVE
 * otherwise. We never default to DELETE: deletion is irreversible, so it stays
 * strictly opt-in. Pre-selecting PROCESS only *stages* the choice; nothing is
 * authorized or submitted until the user clicks "Process … with Hamilton" and
 * clears the authorize/preflight gate, so this default never auto-acts.
 */
function defaultActionFor(grant) {
  const url = grantUrl(grant);
  const ready = !isGrantExpired(grant) && isRenderableUrl(url);
  return ready ? ACTIONS.PROCESS : ACTIONS.LEAVE;
}

function grantFunder(g) {
  return g?.funder || g?.sponsor || g?.funder_name || "—";
}

function grantUrl(g) {
  return g?.url || g?.application_url || g?.source_url || null;
}

function applicationMethodLabel(g) {
  const method = String(g?.application_method || "").toLowerCase();
  if (method) {
    if (method.includes("portal") || method.includes("online")) return "Portal";
    if (method.includes("email")) return "Email";
    if (method.includes("mail")) return "Mail";
    if (method.includes("pdf") || method.includes("doc")) return "PDF/Doc";
    return g.application_method;
  }
  const url = grantUrl(g);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "Link";
    }
  }
  return "—";
}

function formatDeadline(g) {
  if (!g?.deadline) return "—";
  if (String(g.deadline).toLowerCase() === "rolling") return "Rolling";
  const d = new Date(g.deadline);
  return Number.isNaN(d.getTime()) ? String(g.deadline) : d.toLocaleDateString();
}

export default function HamiltonProcessing() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const initialProfileId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("profile_id") || "";
  }, [location.search]);

  const [profileId, setProfileId] = useState(initialProfileId);
  const [actions, setActions] = useState({}); // grant.id -> ACTIONS.*
  const [authOpen, setAuthOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const profilesQuery = useQuery({
    queryKey: ["profiles", "hamilton-processing"],
    queryFn: () => listProfiles({ summary: true }),
    staleTime: 60_000,
  });
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : [];

  const selectedProfile = useMemo(
    () => profiles.find((p) => String(p.id) === String(profileId)) ?? null,
    [profiles, profileId],
  );

  // Keep the API's active profile in sync so the grants list is scoped.
  useEffect(() => {
    client.setActiveProfileId?.(profileId ? String(profileId) : null);
  }, [profileId]);

  const grantsQuery = useQuery({
    queryKey: ["grants", "hamilton-processing", profileId],
    enabled: Boolean(profileId),
    queryFn: () =>
      client.entities.Grant.list("-created_date", 2000, { profile_id: profileId }),
  });

  // Only ever show sources that truly belong to the selected profile — never
  // fall back to organization_id (mirrors the Pipeline page's guard against
  // cross-profile bleed).
  const sources = useMemo(() => {
    const rows = Array.isArray(grantsQuery.data) ? grantsQuery.data : [];
    return rows.filter((g) => Boolean(g?.profile_id) && String(g.profile_id) === String(profileId));
  }, [grantsQuery.data, profileId]);

  // Initialise the action map whenever the source list changes, preserving any
  // choices the user already made for rows that still exist.
  useEffect(() => {
    setActions((prev) => {
      const next = {};
      for (const g of sources) {
        next[g.id] = prev[g.id] ?? defaultActionFor(g);
      }
      return next;
    });
  }, [sources]);

  const counts = useMemo(() => {
    let process = 0;
    let del = 0;
    let leave = 0;
    for (const g of sources) {
      const a = actions[g.id] ?? ACTIONS.LEAVE;
      if (a === ACTIONS.PROCESS) process += 1;
      else if (a === ACTIONS.DELETE) del += 1;
      else leave += 1;
    }
    return { process, del, leave };
  }, [sources, actions]);

  const selectedSources = useMemo(
    () =>
      sources
        .filter((g) => actions[g.id] === ACTIONS.PROCESS)
        .map((g) => ({
          grant_id: g.id,
          opportunity_id: g.funding_opportunity_id || g.opportunity_id || null,
          title: g.title,
          current_stage: g.status,
        })),
    [sources, actions],
  );

  const setAction = (id, action) => setActions((prev) => ({ ...prev, [id]: action }));

  const setAll = (action) => {
    setActions(() => {
      const next = {};
      for (const g of sources) next[g.id] = action;
      return next;
    });
  };

  const idsMarkedDelete = useMemo(
    () => sources.filter((g) => actions[g.id] === ACTIONS.DELETE).map((g) => g.id),
    [sources, actions],
  );

  async function handleDeleteMarked() {
    if (idsMarkedDelete.length === 0) return;
    setIsDeleting(true);
    try {
      await Promise.all(idsMarkedDelete.map((id) => client.entities.Grant.delete(id)));
      await queryClient.invalidateQueries({ queryKey: ["grants"] });
      toast({
        title: "Sources deleted",
        description: `Removed ${idsMarkedDelete.length} funding source${
          idsMarkedDelete.length === 1 ? "" : "s"
        } from the pipeline.`,
      });
      setConfirmDeleteOpen(false);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: err?.message || "Could not delete the selected sources.",
      });
    } finally {
      setIsDeleting(false);
    }
  }

  function handleProcessClick() {
    if (!profileId) {
      toast({
        variant: "destructive",
        title: "Pick a profile first",
        description: "Hamilton needs to know whose applications to complete.",
      });
      return;
    }
    if (selectedSources.length === 0) {
      toast({
        title: "Nothing marked for Hamilton",
        description: 'Set at least one source to "Process" first.',
      });
      return;
    }
    setAuthOpen(true);
  }

  const isLoading = grantsQuery.isLoading && Boolean(profileId);

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-indigo-600" />
              Process Funding Sources with Hamilton
            </h1>
            <p className="text-slate-600 mt-1">
              Decide what Hamilton does with each source in
              {selectedProfile ? (
                <span className="font-semibold text-slate-800"> {selectedProfile.display_name || selectedProfile.name}</span>
              ) : (
                " a profile"
              )}
              's pipeline — process it, leave it alone, or delete it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-500" />
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose a profile…" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.display_name || p.organization_name || p.name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!profileId ? (
          <div className="text-center py-20 text-slate-600">
            Choose a profile above to see its funding sources.
          </div>
        ) : isLoading ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        ) : sources.length === 0 ? (
          <div className="text-center py-20">
            <h3 className="text-lg font-semibold text-slate-900 mb-1">
              No funding sources in this pipeline
            </h3>
            <p className="text-slate-600">
              Add grants to this profile from Discover Grants, then come back to hand them to Hamilton.
            </p>
          </div>
        ) : (
          <>
            {/* Bulk controls + live tally */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 mb-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500">Set all:</span>
                <Button size="sm" variant="outline" onClick={() => setAll(ACTIONS.PROCESS)}>
                  Process
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAll(ACTIONS.LEAVE)}>
                  Leave
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAll(ACTIONS.DELETE)}>
                  Delete
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Badge className="bg-indigo-100 text-indigo-800 hover:bg-indigo-100">
                  {counts.process} to process
                </Badge>
                <Badge variant="secondary">{counts.leave} leave</Badge>
                <Badge className="bg-red-100 text-red-800 hover:bg-red-100">{counts.del} to delete</Badge>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[34%]">Funding Source</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right w-[260px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sources.map((g) => {
                    const action = actions[g.id] ?? ACTIONS.LEAVE;
                    const url = grantUrl(g);
                    return (
                      <TableRow
                        key={g.id}
                        className={
                          action === ACTIONS.DELETE
                            ? "bg-red-50/60"
                            : action === ACTIONS.PROCESS
                              ? "bg-indigo-50/50"
                              : undefined
                        }
                      >
                        <TableCell>
                          <div className="font-medium text-slate-900 leading-snug">{g.title || "Untitled source"}</div>
                          <div className="text-xs text-slate-500 flex items-center gap-1">
                            {grantFunder(g)}
                            {url && (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center text-indigo-600 hover:underline"
                                title="Open application link"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs capitalize text-slate-700">
                            {String(g.status || "—").replace(/_/g, " ")}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-slate-700">{formatDeadline(g)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs font-normal">
                            {applicationMethodLabel(g)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <SegmentedAction value={action} onChange={(a) => setAction(g.id, a)} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Sticky action bar */}
            <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 backdrop-blur px-2 py-3">
              <Button
                variant="outline"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={counts.del === 0}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete {counts.del} marked
              </Button>
              <Button
                onClick={handleProcessClick}
                disabled={counts.process === 0}
                className="bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Process {counts.process} with Hamilton
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Hamilton authorize → preflight → autopilot for the "Process" rows */}
      <HamiltonAutopilotAuthorization
        open={authOpen}
        onOpenChange={setAuthOpen}
        profileId={profileId || null}
        selectedSources={selectedSources}
        onLaunched={() => {
          // Hamilton accepted the run — clear those rows back to "Leave" so the
          // worklist reflects what's left to decide, and refresh the queue.
          setActions((prev) => {
            const next = { ...prev };
            for (const s of selectedSources) {
              if (s.grant_id) next[s.grant_id] = ACTIONS.LEAVE;
            }
            return next;
          });
          queryClient.invalidateQueries({ queryKey: ["hamilton", "tasks"] });
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={(o) => {
          if (!isDeleting) setConfirmDeleteOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {idsMarkedDelete.length} funding source{idsMarkedDelete.length === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the marked source{idsMarkedDelete.length === 1 ? "" : "s"} from
              this profile's pipeline. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteMarked();
              }}
              className="bg-red-600 hover:bg-red-700"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting…
                </>
              ) : (
                `Delete ${idsMarkedDelete.length}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * SegmentedAction — a compact 3-way toggle (Process / Leave / Delete) for a
 * single row. Uses aria-pressed buttons rather than a radio group so the whole
 * control fits on one line and reads clearly at table density.
 */
function SegmentedAction({ value, onChange }) {
  const base = "px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1";
  const opts = [
    { key: ACTIONS.PROCESS, label: "Process", on: "bg-indigo-600 text-white", off: "text-slate-600 hover:bg-indigo-50", ring: "focus:ring-indigo-400" },
    { key: ACTIONS.LEAVE, label: "Leave", on: "bg-slate-600 text-white", off: "text-slate-600 hover:bg-slate-100", ring: "focus:ring-slate-400" },
    { key: ACTIONS.DELETE, label: "Delete", on: "bg-red-600 text-white", off: "text-slate-600 hover:bg-red-50", ring: "focus:ring-red-400" },
  ];
  return (
    <div className="inline-flex rounded-md border border-slate-200 overflow-hidden divide-x divide-slate-200">
      {opts.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={`${base} ${o.ring} ${active ? o.on : `bg-white ${o.off}`}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
