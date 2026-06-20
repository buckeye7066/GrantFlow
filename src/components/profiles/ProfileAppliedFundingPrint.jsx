import React from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Printer } from "lucide-react"
import { listGrants } from "@/api/grants"
import { listDocuments } from "@/api/documents"

function escapeHtml(value) {
  if (value === null) return ""
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatDate(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString()
}

const APPLIED_STATUSES = ["submitted", "under_review", "awarded", "rejected", "closed"]

export default function ProfileAppliedFundingPrint({ organizationId, profileName }) {
  const grantsQuery = useQuery({
    queryKey: ["grants", organizationId, "applied"],
    queryFn: () =>
      listGrants({
        organization_id: organizationId,
        status: APPLIED_STATUSES.join(","),
        limit: 200,
        offset: 0,
      }),
    enabled: Boolean(organizationId),
  })

  const docsQuery = useQuery({
    queryKey: ["documents", organizationId, "applied-grant-docs"],
    queryFn: () =>
      listDocuments({
        organization_id: organizationId,
        type: "proposal",
      }),
    enabled: Boolean(organizationId),
  })

  const grants = Array.isArray(grantsQuery.data) ? grantsQuery.data : []
  const proposalDocs = Array.isArray(docsQuery.data) ? docsQuery.data : []

  const docsByGrant = React.useMemo(() => {
    const map = new Map()
    proposalDocs.forEach((doc) => {
      const grantId = doc.grant_id
      if (!grantId) return
      const list = map.get(grantId) ?? []
      list.push(doc)
      map.set(grantId, list)
    })
    return map
  }, [proposalDocs])

  const isLoading = grantsQuery.isLoading || docsQuery.isLoading

  const handlePrintSummary = () => {
    // No "noopener" — it makes window.open() return null, so the document.write
    // below never runs and the tab opens blank. Same-origin content we own.
    const win = window.open("", "_blank")
    if (!win) return

    const safeTitle = escapeHtml(`${profileName ?? "Profile"} — Applied Funding Sources`)
    const rows = grants
      .map((grant) => {
        const docs = docsByGrant.get(grant.id) ?? []
        const docLinks = docs
          .slice(0, 10)
          .map((doc) => {
            const href = escapeHtml(`${doc.file_url}?disposition=inline`)
            const label = escapeHtml(doc.name || "Application document")
            return `<li><a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a></li>`
          })
          .join("")

        return `
          <tr>
            <td>${escapeHtml(grant.title || "")}</td>
            <td>${escapeHtml(grant.funder || "")}</td>
            <td>${escapeHtml(grant.status || "")}</td>
            <td>${escapeHtml(formatDate(grant.deadline || ""))}</td>
            <td>${docs.length ? `<ul>${docLinks}</ul>` : "<span class='muted'>—</span>"}</td>
          </tr>
        `
      })
      .join("")

    win.document.write(`
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #0f172a; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            .muted { color: #64748b; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            th, td { border: 1px solid #e2e8f0; padding: 10px; vertical-align: top; font-size: 12px; }
            th { background: #f8fafc; text-align: left; }
            ul { margin: 0; padding-left: 16px; }
            a { color: #2563eb; text-decoration: none; }
            a:hover { text-decoration: underline; }
            @media print {
              a[href]:after { content: " (" attr(href) ")"; font-size: 10px; color: #64748b; }
            }
          </style>
        </head>
        <body>
          <h1>${safeTitle}</h1>
          <div class="muted">
            Generated ${escapeHtml(new Date().toLocaleString())}. “Application documents” links open printable versions.
          </div>
          <table>
            <thead>
              <tr>
                <th>Funding Source / Grant</th>
                <th>Funder</th>
                <th>Status</th>
                <th>Deadline</th>
                <th>Application documents</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="5" class="muted">No applied grants found.</td></tr>`}
            </tbody>
          </table>
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
          <CardTitle className="text-lg">Applied funding sources</CardTitle>
          <p className="text-sm text-slate-600">
            Print a summary of funding sources you’ve applied for and open printable application documents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{grants.length} applied</Badge>
          <Button
            variant="outline"
            className="gap-2"
            onClick={handlePrintSummary}
            disabled={!organizationId || isLoading}
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            Print summary
          </Button>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-slate-600">
        <p>
          Note: application document links are pulled from documents tagged as <code>type=proposal</code> and linked to a
          grant.
        </p>
      </CardContent>
    </Card>
  )
}

