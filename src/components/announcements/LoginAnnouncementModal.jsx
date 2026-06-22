/**
 * LoginAnnouncementModal
 *
 * Shows the logged-in user any pending one-time announcements (created by the
 * owner / by Anya via owner.create_announcement) — e.g. "how to merge your
 * portals and what that means". Fetches /api/announcements/pending once on
 * mount, shows them one at a time, and POSTs a dismissal so each appears only
 * once. Renders nothing when there's nothing pending — never blocks the app.
 */
import React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { listPendingAnnouncements, dismissAnnouncement } from "@/api/announcements"

// Minimal, safe markdown: paragraphs, **bold**, ### headings, - bullets. No HTML.
function renderBody(text) {
  const lines = String(text || "").split("\n")
  const out = []
  let list = []
  const flushList = (key) => {
    if (list.length) {
      out.push(<ul key={`ul-${key}`} className="my-2 list-disc pl-5 space-y-1">{list}</ul>)
      list = []
    }
  }
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <React.Fragment key={i}>{part}</React.Fragment>)
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd()
    if (/^#{1,6}\s/.test(line)) {
      flushList(idx)
      out.push(<h4 key={idx} className="mt-3 mb-1 font-semibold text-slate-900">{inline(line.replace(/^#{1,6}\s/, ""))}</h4>)
    } else if (/^[-*]\s/.test(line)) {
      list.push(<li key={idx}>{inline(line.replace(/^[-*]\s/, ""))}</li>)
    } else if (line === "") {
      flushList(idx)
    } else {
      flushList(idx)
      out.push(<p key={idx} className="my-1 text-slate-700">{inline(line)}</p>)
    }
  })
  flushList("end")
  return out
}

export default function LoginAnnouncementModal() {
  const qc = useQueryClient()
  const [idx, setIdx] = React.useState(0)
  const { data } = useQuery({
    queryKey: ["pending-announcements"],
    queryFn: listPendingAnnouncements,
    staleTime: 60_000,
  })
  const dismiss = useMutation({
    mutationFn: (id) => dismissAnnouncement(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["pending-announcements"] }),
  })

  const items = data?.announcements || []
  const current = items[idx]
  if (!current) return null

  const onAck = () => {
    dismiss.mutate(current.id)
    setIdx((i) => i + 1)
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">{current.title}</h3>
          {items.length > 1 ? <span className="shrink-0 text-xs text-slate-400">{idx + 1} / {items.length}</span> : null}
        </div>
        <div className="mt-2 max-h-[60vh] overflow-y-auto text-sm">{renderBody(current.body)}</div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onAck}
            disabled={dismiss.isPending}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
