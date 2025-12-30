import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Filter, Globe, Search } from "lucide-react"
import { base44 } from "../api/base44Client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { Select } from "../components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Badge } from "../components/ui/badge"
import { LoadingState } from "../components/LoadingState"
import { ErrorState } from "../components/ErrorState"
import { EmptyState } from "../components/EmptyState"

type FilterState = {
  search: string
  category: string
  geography: string
  tag: string
}

const CATEGORY_OPTIONS = ["STEM Education", "Health", "Infrastructure", "Community Development"]
const REGION_OPTIONS = ["United States", "Southeast US", "Appalachian Region", "Global"]

export default function SourceDirectory() {
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    category: "",
    geography: "",
    tag: "",
  })
  const [formState, setFormState] = useState<FilterState>({
    search: "",
    category: "",
    geography: "",
    tag: "",
  })

  const opportunitiesQuery = useQuery({
    queryKey: ["discovery", "opportunities", filters],
    queryFn: () => base44.discovery.opportunities.list(filters),
  })

  const isLoading = opportunitiesQuery.isLoading
  const hasError = opportunitiesQuery.isError
  const opportunities = opportunitiesQuery.data ?? []

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <Badge variant="secondary" className="w-fit">
          Opportunity Library
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Source Directory</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Browse curated funding opportunities across crawlers, filter by focus areas, and share highlights with your
          grant teams.
        </p>
      </header>

      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Filter className="h-4 w-4" aria-hidden />
            Filters
          </CardTitle>
          <CardDescription>Use quick filters to narrow the opportunity catalog.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              setFilters(formState)
            }}
          >
            <label className="space-y-1 text-sm font-medium text-foreground">
              Keywords
              <Input
                name="search"
                value={formState.search}
                placeholder="Telehealth, broadband, STEM…"
                onChange={(event) => setFormState((prev) => ({ ...prev, search: event.target.value }))}
              />
            </label>
            <label className="space-y-1 text-sm font-medium text-foreground">
              Category
              <Select
                name="category"
                value={formState.category}
                onChange={(event) => setFormState((prev) => ({ ...prev, category: event.target.value }))}
              >
                <option value="">All categories</option>
                {CATEGORY_OPTIONS.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm font-medium text-foreground">
              Geography
              <Select
                name="geography"
                value={formState.geography}
                onChange={(event) => setFormState((prev) => ({ ...prev, geography: event.target.value }))}
              >
                <option value="">Any geography</option>
                {REGION_OPTIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm font-medium text-foreground">
              Tag
              <Input
                name="tag"
                value={formState.tag}
                placeholder="workforce, rural, broadband…"
                onChange={(event) => setFormState((prev) => ({ ...prev, tag: event.target.value }))}
              />
            </label>
            <div className="md:col-span-2 flex items-center gap-2">
              <Button type="submit">
                <Search className="mr-2 h-4 w-4" aria-hidden />
                Apply filters
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const reset = { search: "", category: "", geography: "", tag: "" }
                  setFormState(reset)
                  setFilters(reset)
                }}
              >
                Clear
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Globe className="h-4 w-4" aria-hidden />
            Opportunity results
          </CardTitle>
          <CardDescription>Curated funding intelligence aggregated from active sources.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingState label="Loading opportunity catalog…" />
          ) : hasError ? (
            <ErrorState onRetry={() => opportunitiesQuery.refetch()} />
          ) : opportunities.length === 0 ? (
            <EmptyState
              title="No opportunities found"
              description="Adjust filters or check back after the next crawler refresh."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opportunity</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Geography</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Deadline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.map((opportunity) => (
                  <TableRow key={opportunity.id}>
                    <TableCell className="space-y-1">
                      <p className="font-medium text-foreground">{opportunity.title}</p>
                      <p className="text-xs text-muted-foreground">{opportunity.summary ?? opportunity.description}</p>
                      <a
                        href={opportunity.source_url ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        View opportunity
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{opportunity.category ?? "General"}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{opportunity.geography ?? "N/A"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {opportunity.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="bg-muted/60">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {opportunity.deadline ? new Date(opportunity.deadline).toLocaleDateString() : "Rolling"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  )
}


