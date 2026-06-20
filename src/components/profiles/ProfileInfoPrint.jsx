import React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FileDown } from "lucide-react"

function escapeHtml(value) {
  if (value === null) return ""
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatSectionKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function renderValue(value, depth = 0) {
  if (value === null || value === undefined || value === "") return ""
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return escapeHtml(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return ""
    const items = value
      .map((item) => {
        if (typeof item === "object" && item !== null) return renderObject(item, depth + 1)
        return `<li>${renderValue(item, depth + 1)}</li>`
      })
      .join("")
    return `<ul>${items}</ul>`
  }
  if (typeof value === "object") return renderObject(value, depth + 1)
  return escapeHtml(String(value))
}

function renderObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object") return ""
  const entries = Object.entries(obj).filter(
    ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
  )
  if (entries.length === 0) return ""
  if (depth > 3) return escapeHtml(JSON.stringify(obj))
  return entries
    .map(([key, val]) => `<tr><td class="label">${escapeHtml(formatSectionKey(key))}</td><td>${renderValue(val, depth)}</td></tr>`)
    .join("")
}

export default function ProfileInfoPrint({ profile }) {
  if (!profile) return null

  const handlePrint = () => {
    // No "noopener" — it makes window.open() return null, so the document.write
    // below never runs and the tab opens blank. Same-origin content we own.
    const win = window.open("", "_blank")
    if (!win) return

    const safeTitle = escapeHtml(`${profile.display_name ?? "Profile"} — Profile Summary`)

    const sections = Array.isArray(profile.sections) ? profile.sections : []
    const sectionBlocks = sections
      .filter((s) => s?.data && typeof s.data === "object" && Object.keys(s.data).length > 0)
      .map((s) => {
        const rows = renderObject(s.data)
        if (!rows) return ""
        return `
          <div class="section">
            <h2>${escapeHtml(formatSectionKey(s.section_key))}</h2>
            <table>${rows}</table>
          </div>
        `
      })
      .filter(Boolean)
      .join("")

    win.document.write(`
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #0f172a; max-width: 800px; margin: 0 auto; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            h2 { font-size: 15px; margin: 0 0 8px; color: #1e40af; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
            .meta { color: #64748b; font-size: 12px; margin-bottom: 20px; }
            .section { margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; }
            td { border: 1px solid #e2e8f0; padding: 6px 10px; vertical-align: top; font-size: 12px; }
            td.label { font-weight: 600; width: 200px; background: #f8fafc; white-space: nowrap; }
            ul { margin: 2px 0; padding-left: 16px; }
            li { font-size: 12px; }
            @media print {
              body { padding: 0; }
              .section { break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <h1>${safeTitle}</h1>
          <div class="meta">
            Type: ${escapeHtml(profile.primary_type || "—")}
            &nbsp;|&nbsp; Generated ${escapeHtml(new Date().toLocaleString())}
          </div>
          ${sectionBlocks || '<p class="meta">No profile sections found.</p>'}
        </body>
      </html>
    `)
    win.document.close()
    win.focus()
    win.print()
  }

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-lg">Profile summary (PDF)</CardTitle>
          <p className="text-sm text-slate-600">
            Save all profile information as a printable PDF document.
          </p>
        </div>
        <Button onClick={handlePrint} className="gap-2">
          <FileDown className="w-4 h-4" />
          Save as PDF
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Click "Save as PDF" to open a print-friendly view of all profile sections.
          Use your browser's print dialog to save as PDF or print directly.
        </p>
      </CardContent>
    </Card>
  )
}
