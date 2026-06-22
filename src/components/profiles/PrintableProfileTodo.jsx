import React, { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Loader2, Printer, ClipboardList, Clock, FileText, DollarSign,
  Award, Folder, Phone, Target, AlertCircle, ChevronDown, ChevronUp, ArrowRight,
} from "lucide-react"
import { apiFetch } from "@/api/client"
import { buildProfileSectionLink } from "@/config/missingInfoTargets"

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

function buildPrintHtml(todo, applicantName) {
  const title = escapeHtml(`${applicantName} — Action Plan & Checklist`)
  const date = new Date().toLocaleDateString()
  const summary = escapeHtml(todo.summary || "")

  const categoriesHtml = (todo.categories || [])
    .map((cat) => {
      const items = (cat.items || [])
        .map(
          (item, idx) => `
          <div class="todo-item">
            <div class="todo-header">
              <span class="checkbox">&#9744;</span>
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

function TodoItemCard({ item, profileId }) {
  const [expanded, setExpanded] = useState(false)
  const PriorityBadge = () => (
    <Badge variant="outline" className={`text-xs ${PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.medium}`}>
      {item.priority || "medium"}
    </Badge>
  )

  const hasDetails = Boolean(item.instructions || item.resources_needed || item.contact_or_location)
  const toggle = () => setExpanded((v) => !v)

  // Deep-link this todo into the matching ProfileDetail section when the AI
  // tagged it as a profile-field item (field_key preferred, else profile_section).
  const profileLink = buildProfileSectionLink(profileId, item.field_key || item.profile_section)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
      }}
      className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-slate-50 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400 ${
        expanded ? 'bg-slate-50 border-blue-200' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 text-slate-400 text-lg shrink-0">&#9744;</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-slate-900">{item.title}</span>
            <PriorityBadge />
            {item.deadline && (
              <span className="text-xs text-red-600 font-medium">Due: {item.deadline}</span>
            )}
            {profileLink && (
              <Link
                to={profileLink}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
              >
                Fix in profile
                <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
          {!expanded && hasDetails && (
            <span className="text-xs text-blue-600 mt-1 inline-block">Tap to see step-by-step instructions →</span>
          )}
        </div>
        {hasDetails && (expanded ? (
          <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        ))}
      </div>
      {expanded && hasDetails && (
        <div className="ml-7 mt-2 space-y-2 text-sm">
          {item.instructions && (
            <p className="text-slate-700 whitespace-pre-wrap">{item.instructions}</p>
          )}
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
    </div>
  )
}

// Lightweight staged status so the ~12-14s generation isn't a bare spinner.
// These are cosmetic checkpoints timed to the typical request duration — they
// give the user a sense of progress without claiming to know the exact server
// stage. The final stage holds until the request resolves.
const GENERATION_STAGES = [
  { at: 0, label: "Analyzing profile…" },
  { at: 3000, label: "Reviewing your pipeline…" },
  { at: 6000, label: "Drafting tasks…" },
  { at: 9000, label: "Setting deadlines & priorities…" },
  { at: 12000, label: "Finishing up…" },
]

export default function PrintableProfileTodo({ profileId, profileName }) {
  const [todoData, setTodoData] = useState(null)
  const [progressLabel, setProgressLabel] = useState(GENERATION_STAGES[0].label)

  const generateMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/ai/generate-profile-todo", {
        method: "POST",
        body: JSON.stringify({ profile_id: profileId }),
      }),
    onSuccess: (data) => {
      if (data?.success && data.todo) {
        setTodoData(data)
      }
    },
  })

  const isGenerating = generateMutation.isPending

  // Advance the staged status text while a generation is in flight; reset to the
  // first stage whenever a new generation starts.
  useEffect(() => {
    if (!isGenerating) return undefined
    setProgressLabel(GENERATION_STAGES[0].label)
    const timers = GENERATION_STAGES.slice(1).map((stage) =>
      setTimeout(() => setProgressLabel(stage.label), stage.at),
    )
    return () => timers.forEach(clearTimeout)
  }, [isGenerating])

  const handlePrint = () => {
    if (!todoData?.todo) return
    // No "noopener" — it makes window.open() return null, so the document.write
    // below never runs and the tab opens blank. Same-origin content we own.
    const win = window.open("", "_blank")
    if (!win) return
    let html
    try {
      html = buildPrintHtml(todoData.todo, todoData.applicant_name || profileName || "Profile")
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

  const todo = todoData?.todo
  const categories = todo?.categories || []
  const computedTotal = categories.reduce((sum, c) => sum + (c.items?.length || 0), 0)
  const totalItems = (typeof todo?.total_items === "number" && todo.total_items > 0)
    ? todo.total_items
    : computedTotal

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-blue-600" />
            Profile Action Plan
          </CardTitle>
          <p className="text-sm text-slate-600 mt-1">
            Generate a personalized checklist of everything this profile needs to do, with detailed
            step-by-step instructions for each task. Print it out and check items off as you go.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {todo && (
            <>
              <Badge variant="outline">{totalItems} items</Badge>
              <Button variant="outline" className="gap-2" onClick={handlePrint}>
                <Printer className="w-4 h-4" />
                Print
              </Button>
            </>
          )}
          <Button
            className="gap-2"
            onClick={() => generateMutation.mutate()}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ClipboardList className="w-4 h-4" />
            )}
            {isGenerating ? progressLabel : todo ? "Regenerate" : "Generate Checklist"}
          </Button>
        </div>
      </CardHeader>

      {isGenerating && (
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            <span>{progressLabel}</span>
            <span className="text-xs text-slate-400">This usually takes about 10-15 seconds.</span>
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
                  {(cat.items || []).map((item, itemIdx) => (
                    <TodoItemCard key={itemIdx} item={item} profileId={profileId} />
                  ))}
                </div>
              </div>
            )
          })}

          <div className="text-center pt-4 border-t text-xs text-slate-400">
            {totalItems} action items &middot; Click any item to expand details &middot; Use the Print button for a paper copy
          </div>
        </CardContent>
      )}
    </Card>
  )
}
