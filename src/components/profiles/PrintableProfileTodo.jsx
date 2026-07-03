import React, { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Loader2, Printer, ClipboardList, Clock, FileText, DollarSign,
  Award, Folder, Phone, Target, AlertCircle, ChevronDown, ChevronUp, ArrowRight,
  CheckSquare, Square, Upload, CheckCircle2,
} from "lucide-react"
import { apiFetch } from "@/api/client"
import { ingestDocument } from "@/api/documents"
import { useToast } from "@/components/ui/use-toast"
import { buildProfileSectionLink } from "@/config/missingInfoTargets"
import { createPageUrl } from "@/utils"

const ICON_MAP = {
  clipboard: ClipboardList,
  clock: Clock,
  "file-text": FileText,
  "dollar-sign": DollarSign,
  award: Award,
  folder: Folder,
  phone: Phone,
  target: Target,
}

const PRIORITY_STYLES = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
}

// Stable per-item key so a checked item STAYS checked across "Regenerate".
// Must match the backend's expectation (it just stores whatever key we send).
function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
}
function itemKey(categoryName, item) {
  return `${slug(categoryName)}::${slug(item?.title)}`
}

function escapeHtml(value) {
  if (value === null) return ""
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\//g, "&#x2F;")
}

function buildPrintHtml(todo, applicantName, completions = {}) {
  const title = escapeHtml(`${applicantName} — Action Plan & Checklist`)
  const date = new Date().toLocaleDateString()
  const summary = escapeHtml(todo.summary || "")

  const categoriesHtml = (todo.categories || [])
    .map((cat) => {
      const items = (cat.items || [])
        .map(
          (item) => {
            const done = Boolean(completions[itemKey(cat.name, item)]?.done)
            return `
          <div class="todo-item${done ? " done" : ""}">
            <div class="todo-header">
              <span class="checkbox">${done ? "&#9745;" : "&#9744;"}</span>
              <span class="todo-title">${escapeHtml(item.title)}</span>
              <span class="priority priority-${item.priority || "medium"}">${escapeHtml(item.priority || "medium")}</span>
              ${item.deadline ? `<span class="deadline">Due: ${escapeHtml(item.deadline)}</span>` : ""}
            </div>
            <div class="todo-body">
              <div class="instructions">${escapeHtml(item.instructions || "").replace(/\n/g, "<br>")}</div>
              ${item.resources_needed ? `<div class="detail"><strong>What you need:</strong> ${escapeHtml(item.resources_needed)}</div>` : ""}
              ${item.contact_or_location ? `<div class="detail"><strong>Contact / Where to go:</strong> ${escapeHtml(item.contact_or_location)}</div>` : ""}
            </div>
          </div>`
          }
        )
        .join("")
      return `
        <div class="category">
          <h2 class="category-title">${escapeHtml(cat.name)}</h2>
          ${items}
        </div>`
    })
    .join("")

  return `<html>
<head>
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; padding: 24px 32px; color: #1e293b; max-width: 850px; margin: 0 auto; line-height: 1.5; }
    h1 { font-size: 22px; margin: 0 0 4px; color: #0f172a; }
    .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
    .summary { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 14px; color: #0c4a6e; }
    .category { margin-bottom: 28px; page-break-inside: avoid; }
    .category-title { font-size: 16px; font-weight: 700; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 12px; }
    .todo-item { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; page-break-inside: avoid; }
    .todo-item.done { background: #f0fdf4; border-color: #bbf7d0; }
    .todo-item.done .todo-title { text-decoration: line-through; color: #64748b; }
    .todo-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .checkbox { font-size: 20px; color: #94a3b8; flex-shrink: 0; }
    .todo-title { font-weight: 600; font-size: 14px; flex: 1; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .priority-critical { background: #fee2e2; color: #991b1b; }
    .priority-high { background: #ffedd5; color: #9a3412; }
    .priority-medium { background: #dbeafe; color: #1e40af; }
    .priority-low { background: #f1f5f9; color: #475569; }
    .deadline { font-size: 12px; color: #dc2626; font-weight: 500; }
    .todo-body { padding-left: 28px; }
    .instructions { font-size: 13px; color: #334155; margin-bottom: 6px; white-space: pre-wrap; }
    .detail { font-size: 12px; color: #475569; margin-top: 4px; }
    .detail strong { color: #1e293b; }
    .footer { text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
    @media print {
      body { padding: 16px; }
      .todo-item { break-inside: avoid; }
      .category { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">Generated ${escapeHtml(date)} &middot; ${escapeHtml(String(todo.total_items || 0))} action items</div>
  ${summary ? `<div class="summary">${escapeHtml(summary)}</div>` : ""}
  ${categoriesHtml}
  <div class="footer">GrantFlow Profile Action Plan &middot; Print this page and check off items as you complete them.</div>
</body>
</html>`
}

function TodoItemCard({ item, profileId, categoryName, done, onToggleDone, onUploaded, busy }) {
  const [expanded, setExpanded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const { toast } = useToast()

  const PriorityBadge = () => (
    <Badge variant="outline" className={`text-xs ${PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.medium}`}>
      {item.priority || "medium"}
    </Badge>
  )

  const hasDetails = Boolean(item.instructions || item.resources_needed || item.contact_or_location)
  const toggle = () => setExpanded((v) => !v)

  // Deep-link this todo into the matching ProfileDetail section when the AI
  // tagged it as a profile-field item (field_key preferred, else profile_section).
  // This is the "add the information manually to the profile" path.
  const profileLink = buildProfileSectionLink(profileId, item.field_key || item.profile_section)

  // Hamilton items carry an explicit navigation target ({tab, focus}) so one
  // click drops the user exactly where the need is fixed (e.g. the portal
  // sign-in list for a "sign in once" item). Falls back to the field link.
  const goToLink = !profileLink && item.go_to?.tab
    ? createPageUrl("ProfileDetail", {
        id: profileId,
        tab: item.go_to.tab,
        focus: item.go_to.focus || undefined,
      })
    : null

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-selecting the same file later
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("profile_id", profileId)
      fd.append("document", file)
      fd.append("enable_ai", "true")
      fd.append("ocr", "true")
      fd.append("handwriting", "true")
      fd.append("ocr_language", "eng")
      const res = await ingestDocument(fd)
      const docId = res?.document?.id ?? res?.id ?? null
      await onUploaded(docId)
      toast({ title: "Uploaded", description: `“${file.name}” attached to the profile and this task marked done.` })
    } catch (err) {
      toast({ variant: "destructive", title: "Upload failed", description: err?.message || "Could not attach the file." })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      className={`border rounded-lg p-3 transition-colors ${
        done ? "bg-emerald-50 border-emerald-200" : "hover:bg-slate-50 hover:border-blue-300"
      } ${expanded ? "ring-1 ring-blue-200" : ""}`}
    >
      <div className="flex items-start gap-2">
        {/* Checkbox — click to mark done (does NOT expand the card). */}
        <button
          type="button"
          aria-pressed={done}
          aria-label={done ? "Mark not done" : "Mark done"}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onToggleDone(!done) }}
          className="mt-0.5 shrink-0 text-slate-400 hover:text-emerald-600 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : done ? (
            <CheckSquare className="w-5 h-5 text-emerald-600" />
          ) : (
            <Square className="w-5 h-5" />
          )}
        </button>

        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle() } }}
          className="flex-1 min-w-0 cursor-pointer focus:outline-none"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-medium text-sm ${done ? "line-through text-slate-500" : "text-slate-900"}`}>
              {item.title}
            </span>
            <PriorityBadge />
            {item.deadline && !done && (
              <span className="text-xs text-red-600 font-medium">Due: {item.deadline}</span>
            )}
            {done && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" /> Done
              </span>
            )}
          </div>
          {!expanded && hasDetails && (
            <span className="text-xs text-blue-600 mt-1 inline-block">Tap to see step-by-step instructions →</span>
          )}
        </div>

        {hasDetails && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle() }}
            className="shrink-0 mt-0.5 text-slate-400"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>

      {expanded && hasDetails && (
        <div className="ml-7 mt-2 space-y-2 text-sm">
          {item.instructions && <p className="text-slate-700 whitespace-pre-wrap">{item.instructions}</p>}
          {item.resources_needed && (
            <p className="text-slate-600">
              <span className="font-medium text-slate-800">What you need:</span> {item.resources_needed}
            </p>
          )}
          {item.contact_or_location && (
            <p className="text-slate-600">
              <span className="font-medium text-slate-800">Contact / Where to go:</span> {item.contact_or_location}
            </p>
          )}
        </div>
      )}

      {/* Per-item actions: upload a file, add to the profile, or just mark done. */}
      <div className="ml-7 mt-2 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" className="hidden" onChange={handleFile} />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
          disabled={uploading || busy}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50"
        >
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          Upload file
        </button>
        {profileLink && (
          <Link
            to={profileLink}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
          >
            Add to profile <ArrowRight className="w-3 h-3" />
          </Link>
        )}
        {goToLink && (
          <Link
            to={goToLink}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
          >
            Go there <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
    </div>
  )
}

// Lightweight staged status so the ~12-14s generation isn't a bare spinner.
const GENERATION_STAGES = [
  { at: 0, label: "Analyzing profile…" },
  { at: 3000, label: "Reviewing your pipeline…" },
  { at: 6000, label: "Drafting tasks…" },
  { at: 9000, label: "Setting deadlines & priorities…" },
  { at: 12000, label: "Finishing up…" },
]

export default function PrintableProfileTodo({ profileId, profileName }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [progressLabel, setProgressLabel] = useState(GENERATION_STAGES[0].label)
  const planKey = ["profile-todo", profileId]

  // Load the PERSISTED plan + completion state (survives reload + Regenerate).
  const planQuery = useQuery({
    queryKey: planKey,
    queryFn: () => apiFetch(`/api/ai/profile-todo?profile_id=${encodeURIComponent(profileId)}`),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })

  const todo = planQuery.data?.todo || null
  const completions = planQuery.data?.completions || {}

  const generateMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/ai/generate-profile-todo", {
        method: "POST",
        body: JSON.stringify({ profile_id: profileId }),
      }),
    onSuccess: () => {
      // The server persisted the plan; refetch to pick up plan + completions.
      queryClient.invalidateQueries({ queryKey: planKey })
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Couldn't generate", description: err?.message || "Please try again." })
    },
  })

  // Toggle completion with an optimistic update so the checkbox feels instant.
  const completeMutation = useMutation({
    mutationFn: ({ item_key, done, doc_id }) =>
      apiFetch("/api/ai/profile-todo/complete", {
        method: "POST",
        body: JSON.stringify({ profile_id: profileId, item_key, done, doc_id }),
      }),
    onMutate: async ({ item_key, done, doc_id }) => {
      await queryClient.cancelQueries({ queryKey: planKey })
      const prev = queryClient.getQueryData(planKey)
      queryClient.setQueryData(planKey, (old) => {
        const next = { ...(old || {}) }
        const map = { ...(next.completions || {}) }
        if (done) map[item_key] = { done: true, doc_id: doc_id || null, at: new Date().toISOString() }
        else delete map[item_key]
        next.completions = map
        return next
      })
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(planKey, ctx.prev)
      toast({ variant: "destructive", title: "Couldn't update", description: err?.message || "Please try again." })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: planKey }),
  })

  const isGenerating = generateMutation.isPending

  useEffect(() => {
    if (!isGenerating) return undefined
    setProgressLabel(GENERATION_STAGES[0].label)
    const timers = GENERATION_STAGES.slice(1).map((stage) =>
      setTimeout(() => setProgressLabel(stage.label), stage.at),
    )
    return () => timers.forEach(clearTimeout)
  }, [isGenerating])

  const handlePrint = () => {
    if (!todo) return
    const win = window.open("", "_blank")
    if (!win) return
    let html
    try {
      html = buildPrintHtml(todo, planQuery.data?.applicant_name || profileName || "Profile", completions)
    } catch (err) {
      win.close()
      console.error("[PrintableProfileTodo] buildPrintHtml failed:", err)
      return
    }
    win.document.write(html)
    win.document.close()
    win.focus()
    win.onload = () => { win.print() }
  }

  const categories = todo?.categories || []
  const allItems = categories.flatMap((c) => (c.items || []).map((item) => ({ item, categoryName: c.name })))
  const computedTotal = allItems.length
  const totalItems = (typeof todo?.total_items === "number" && todo.total_items > 0) ? todo.total_items : computedTotal
  const doneCount = allItems.filter(({ item, categoryName }) => completions[itemKey(categoryName, item)]?.done).length

  const isLoadingPlan = planQuery.isLoading

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-blue-600" />
            Profile Action Plan
          </CardTitle>
          <p className="text-sm text-slate-600 mt-1">
            A personalized checklist of everything this profile needs to do. Check items off as you go,
            upload a file to complete a task, or add the information to the profile. Your progress is saved.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {todo && (
            <>
              <Badge variant="outline" className={doneCount === totalItems && totalItems > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : ""}>
                {doneCount}/{totalItems} done
              </Badge>
              <Button variant="outline" className="gap-2" onClick={handlePrint}>
                <Printer className="w-4 h-4" />
                Print
              </Button>
            </>
          )}
          <Button className="gap-2" onClick={() => generateMutation.mutate()} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
            {isGenerating ? progressLabel : todo ? "Regenerate" : "Generate Checklist"}
          </Button>
        </div>
      </CardHeader>

      {(isGenerating || (isLoadingPlan && !todo)) && (
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            <span>{isGenerating ? progressLabel : "Loading your plan…"}</span>
            {isGenerating && <span className="text-xs text-slate-400">This usually takes about 10-15 seconds.</span>}
          </div>
        </CardContent>
      )}

      {generateMutation.isError && (
        <CardContent>
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4" />
            {generateMutation.error?.message || "Failed to generate checklist. Please try again."}
          </div>
        </CardContent>
      )}

      {todo && categories.length > 0 && (
        <CardContent className="space-y-6">
          {todo.summary && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
              {todo.summary}
            </div>
          )}

          {categories.map((cat, catIdx) => {
            const IconComponent = ICON_MAP[cat.icon] || ClipboardList
            return (
              <div key={catIdx}>
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900 mb-3">
                  <IconComponent className="w-4 h-4 text-slate-500" />
                  {cat.name}
                  <Badge variant="secondary" className="text-xs font-normal">
                    {cat.items?.length || 0}
                  </Badge>
                </h3>
                <div className="space-y-2">
                  {(cat.items || []).map((item, itemIdx) => {
                    const key = itemKey(cat.name, item)
                    return (
                      <TodoItemCard
                        key={itemIdx}
                        item={item}
                        profileId={profileId}
                        categoryName={cat.name}
                        done={Boolean(completions[key]?.done)}
                        busy={completeMutation.isPending && completeMutation.variables?.item_key === key}
                        onToggleDone={(done) => completeMutation.mutate({ item_key: key, done })}
                        onUploaded={async (docId) => { await completeMutation.mutateAsync({ item_key: key, done: true, doc_id: docId }) }}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className="text-center pt-4 border-t text-xs text-slate-400">
            {doneCount}/{totalItems} done &middot; Check the box, upload a file, or add to the profile &middot; Use Print for a paper copy
          </div>
        </CardContent>
      )}
    </Card>
  )
}
