import { useEffect, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BookOpen, Filter, Loader2, Plus, RefreshCcw, Save, Search } from "lucide-react"
import { base44, type DiscoveryTemplate, type FundingOpportunity } from "../api/base44Client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { Select } from "../components/ui/select"
import { Input } from "../components/ui/input"
import { Textarea } from "../components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Badge } from "../components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog"
import { LoadingState } from "../components/LoadingState"
import { ErrorState } from "../components/ErrorState"
import { EmptyState } from "../components/EmptyState"

type SearchFormValues = {
  templateId: string
  query: string
  category: string
  geography: string
  tags: string
  profileId: string
}

export default function DiscoverGrants() {
  const queryClient = useQueryClient()
  const [activeTemplate, setActiveTemplate] = useState<DiscoveryTemplate | null>(null)
  const [results, setResults] = useState<FundingOpportunity[]>([])
  const [runSummary, setRunSummary] = useState<{ id: string; result_count: number; query: string } | null>(null)
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [templateDescription, setTemplateDescription] = useState("")

  const templatesQuery = useQuery({
    queryKey: ["discovery", "templates"],
    queryFn: () => base44.discovery.templates.list(),
  })

  const savedSearchesQuery = useQuery({
    queryKey: ["discovery", "saved-searches"],
    queryFn: () => base44.discovery.savedSearches.list(),
  })

  const runsQuery = useQuery({
    queryKey: ["discovery", "runs"],
    queryFn: () => base44.discovery.runs.list(),
  })

  const activityQuery = useQuery({
    queryKey: ["discovery", "activity"],
    queryFn: () => base44.discovery.activity.list(),
  })

  const form = useForm<SearchFormValues>({
    defaultValues: {
      templateId: "",
      query: "",
      category: "",
      geography: "",
      tags: "",
      profileId: "",
    },
  })

  useEffect(() => {
    if (templatesQuery.data && templatesQuery.data.length > 0 && !activeTemplate) {
      const defaultTemplate = templatesQuery.data.find((template) => template.is_default) ?? templatesQuery.data[0]
      applyTemplate(defaultTemplate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesQuery.data])

  const runSearchMutation = useMutation({
    mutationFn: async (values: SearchFormValues) => {
      const tags = values.tags
        ? values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : []
      const response = await base44.discovery.run({
        templateId: values.templateId || undefined,
        profileId: values.profileId || undefined,
        query: values.query || undefined,
        executedBy: "admin",
        filters: {
          category: values.category || undefined,
          geography: values.geography || undefined,
          tags: tags.length ? tags : undefined,
        },
      })
      return response
    },
    onSuccess: (response) => {
      setResults(response.data)
      setRunSummary({
        id: response.run.id,
        result_count: response.run.result_count,
        query: response.run.query,
      })
      void queryClient.invalidateQueries({ queryKey: ["discovery", "runs"] })
      void queryClient.invalidateQueries({ queryKey: ["discovery", "activity"] })
    },
  })

  const saveTemplateMutation = useMutation({
    mutationFn: async (payload: { name: string; description: string }) => {
      const values = form.getValues()
      const tags = values.tags
        ? values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : []
      return base44.discovery.templates.create({
        name: payload.name,
        description: payload.description,
        query: values.query,
        filters: {
          category: values.category || undefined,
          geography: values.geography || undefined,
          tags: tags.length ? tags : undefined,
        },
        owner_id: null,
      })
    },
    onSuccess: () => {
      setTemplateName("")
      setTemplateDescription("")
      setIsSaveDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["discovery", "templates"] })
    },
  })

  const applyTemplate = (template: DiscoveryTemplate) => {
    setActiveTemplate(template)
    form.setValue("templateId", template.id)
    form.setValue("query", template.query ?? "")
    const filters = template.filters ?? {}
    form.setValue("category", typeof filters.category === "string" ? filters.category : "")
    form.setValue("geography", typeof filters.geography === "string" ? filters.geography : "")
    const tags = Array.isArray(filters.tags) ? filters.tags.join(", ") : ""
    form.setValue("tags", tags)
  }

  const handleSubmit = (values: SearchFormValues) => {
    runSearchMutation.mutate(values)
  }

  const handleReset = () => {
    setResults([])
    setRunSummary(null)
  }

  const isLoading =
    templatesQuery.isLoading || savedSearchesQuery.isLoading || runsQuery.isLoading || activityQuery.isLoading
  const hasError =
    templatesQuery.isError || savedSearchesQuery.isError || runsQuery.isError || activityQuery.isError

  const recentActivity = useMemo(() => activityQuery.data ?? [], [activityQuery.data])

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <LoadingState label="Loading discovery workspace..." />
      </main>
    )
  }

  if (hasError) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <ErrorState onRetry={() => queryClient.invalidateQueries({ queryKey: ["discovery"] })} />
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <Badge variant="secondary" className="w-fit">
          Discovery & Matching
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Discover Grants</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Run templated searches, refine filters, and review AI-curated opportunities tailored to your partner
          portfolio.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card className="border-muted/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Search className="h-4 w-4" aria-hidden />
              Search Builder
            </CardTitle>
            <CardDescription>
              Select a template, adjust filters, and run the search to see matching funding opportunities.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={form.handleSubmit(handleSubmit)}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Template
                  <Select
                    value={form.watch("templateId")}
                    onChange={(event) => {
                      const template = templatesQuery.data?.find((item) => item.id === event.target.value)
                      if (template) {
                        applyTemplate(template)
                      } else {
                        form.setValue("templateId", event.target.value)
                      }
                    }}
                  >
                    <option value="">Custom filters</option>
                    {templatesQuery.data?.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Linked profile
                  <Input placeholder="Optional profile ID" {...form.register("profileId")} />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Keywords
                  <Input placeholder="STEM workforce, rural broadband…" {...form.register("query")} />
                </label>
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Category
                  <Input placeholder="STEM Education, Health, Infrastructure…" {...form.register("category")} />
                </label>
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Geography
                  <Input placeholder="United States, Southeast, Appalachia…" {...form.register("geography")} />
                </label>
                <label className="space-y-1 text-sm font-medium text-foreground">
                  Tags
                  <Input placeholder="Comma separated e.g. workforce, telehealth" {...form.register("tags")} />
                </label>
              </div>

              <div className="flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={handleReset}>
                  Clear results
                </Button>
                <Button type="submit" disabled={runSearchMutation.isPending}>
                  {runSearchMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      Searching…
                    </>
                  ) : (
                    <>
                      <Filter className="mr-2 h-4 w-4" aria-hidden />
                      Run search
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-muted/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <BookOpen className="h-4 w-4" aria-hidden />
              Templates & saved searches
            </CardTitle>
            <CardDescription>Quickly reuse discovery recipes across your portfolio.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {templatesQuery.data?.length ? (
                templatesQuery.data.map((template) => (
                  <Button
                    key={template.id}
                    variant={template.id === activeTemplate?.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => applyTemplate(template)}
                  >
                    {template.name}
                  </Button>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No templates available.</p>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Saved searches</h3>
              {savedSearchesQuery.data?.length ? (
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {savedSearchesQuery.data.map((search) => (
                    <li key={search.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">{search.name}</span>
                        <span className="text-xs">{search.schedule ? `Scheduled: ${search.schedule}` : "Manual run"}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{search.description ?? "No description"}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No saved searches"
                  description="Save your commonly used filters to re-run them in a click."
                  action={
                    <Button variant="secondary" onClick={() => setIsSaveDialogOpen(true)}>
                      <Save className="mr-2 h-3.5 w-3.5" aria-hidden />
                      Save current filters
                    </Button>
                  }
                />
              )}
            </div>

            <Button variant="outline" className="w-full" onClick={() => setIsSaveDialogOpen(true)}>
              <Save className="mr-2 h-4 w-4" aria-hidden />
              Save current filters as template
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Filter className="h-4 w-4" aria-hidden />
            Results
          </CardTitle>
          <CardDescription>
            {runSummary
              ? `${runSummary.result_count} opportunities matched your filters.`
              : "Run a search to see matching opportunities."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runSearchMutation.isPending ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              title="No opportunities yet"
              description="Adjust filters or run a search to view discovery results."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opportunity</TableHead>
                  <TableHead>Funding</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((opportunity) => (
                  <TableRow key={opportunity.id}>
                    <TableCell className="space-y-1">
                      <p className="font-medium text-foreground">{opportunity.title}</p>
                      <p className="text-xs text-muted-foreground">{opportunity.summary}</p>
                    </TableCell>
                    <TableCell>
                      {opportunity.amount_min != null || opportunity.amount_max != null ? (
                        <span className="text-sm text-foreground">
                          {formatAmount(opportunity.amount_min)}–{formatAmount(opportunity.amount_max)} {opportunity.currency ?? ""}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not specified</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{opportunity.category ?? "General"}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {opportunity.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="bg-muted/50">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {opportunity.deadline ? new Date(opportunity.deadline).toLocaleDateString() : "Rolling"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <a
                        href={opportunity.source_url ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-600 hover:underline"
                      >
                        View source
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-muted/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <RefreshCcw className="h-4 w-4" aria-hidden />
              Recent runs
            </CardTitle>
            <CardDescription>Latest discovery runs and their outcomes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {runsQuery.data?.length ? (
              runsQuery.data.map((run) => (
                <div key={run.id} className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">{run.query || "Template run"}</span>
                    <span className="text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{run.result_count} results captured</p>
                </div>
              ))
            ) : (
              <EmptyState title="No runs yet" description="Run a search to see its history here." />
            )}
          </CardContent>
        </Card>

        <Card className="border-muted/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Plus className="h-4 w-4" aria-hidden />
              Activity log
            </CardTitle>
            <CardDescription>Latest crawler and search activity across discovery sources.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentActivity.length ? (
              recentActivity.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">{entry.type}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{entry.message ?? "Activity recorded."}</p>
                </div>
              ))
            ) : (
              <EmptyState title="No activity yet" description="Run discovery jobs to populate the activity timeline." />
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
          <DialogContent>
          <DialogHeader>
            <DialogTitle>Save search template</DialogTitle>
            <DialogDescription>Provide a name and description to store this discovery recipe for reuse.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="space-y-1 text-sm font-medium text-foreground">
              Name
              <Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm font-medium text-foreground">
              Description
              <Textarea
                rows={3}
                value={templateDescription}
                onChange={(event) => setTemplateDescription(event.target.value)}
              />
            </label>
          </div>
          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setTemplateName("")
                setTemplateDescription("")
                setIsSaveDialogOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!templateName.trim()) {
                  return
                }
                saveTemplateMutation.mutate({
                  name: templateName.trim(),
                  description: templateDescription,
                })
              }}
              disabled={saveTemplateMutation.isPending}
            >
              {saveTemplateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" aria-hidden />
                  Save template
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function formatAmount(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "—"
  }
  return `$${value.toLocaleString()}`
}


