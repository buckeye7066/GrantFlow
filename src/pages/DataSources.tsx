import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ActivitySquare, Clock3, Loader2, Pause, Play, RefreshCcw } from "lucide-react"
import { base44, type DiscoveryActivity } from "../api/base44Client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Badge } from "../components/ui/badge"
import { LoadingState } from "../components/LoadingState"
import { ErrorState } from "../components/ErrorState"
import { EmptyState } from "../components/EmptyState"

export default function DataSources() {
  const queryClient = useQueryClient()

  const sourcesQuery = useQuery({
    queryKey: ["discovery", "sources"],
    queryFn: () => base44.discovery.sources.list(),
  })

  const activityQuery = useQuery({
    queryKey: ["discovery", "activity"],
    queryFn: () => base44.discovery.activity.list(),
  })

  const updateSourceMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      return base44.discovery.sources.update(id, { status })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["discovery", "sources"] })
    },
  })

  const runSourceMutation = useMutation({
    mutationFn: async (id: string) => {
      return base44.discovery.sources.run(id)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["discovery", "sources"] })
      void queryClient.invalidateQueries({ queryKey: ["discovery", "activity"] })
    },
  })

  const isLoading = sourcesQuery.isLoading || activityQuery.isLoading
  const hasError = sourcesQuery.isError || activityQuery.isError

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <LoadingState label="Loading discovery sources..." />
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

  const sources = sourcesQuery.data ?? []
  const activity = activityQuery.data ?? []

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <Badge variant="secondary" className="w-fit">
          Crawlers & Data Feeds
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Data Sources</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Monitor crawler schedules, trigger refreshes, and review ingestion activity across your discovery network.
        </p>
      </header>

      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <RefreshCcw className="h-4 w-4" aria-hidden />
            Source status
          </CardTitle>
          <CardDescription>Manage ingestion cadence and view health for each feed.</CardDescription>
        </CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <EmptyState title="No data sources" description="Discovery sources will appear here once configured." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.id} className="align-top">
                    <TableCell className="space-y-1">
                      <p className="font-medium text-foreground">{source.name}</p>
                      <p className="text-xs text-muted-foreground">{source.description ?? "No description provided."}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {source.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{source.region ?? "Multi-region"}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={source.status === "active" ? "default" : "secondary"} className="capitalize">
                        {source.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{source.schedule ?? "Manual"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {source.last_run_at ? new Date(source.last_run_at).toLocaleString() : "Not run"}
                    </TableCell>
                    <TableCell className="flex flex-col gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateSourceMutation.mutate({
                            id: source.id,
                            status: source.status === "active" ? "paused" : "active",
                          })
                        }
                        disabled={updateSourceMutation.isPending}
                      >
                        {updateSourceMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : source.status === "active" ? (
                          <>
                            <Pause className="mr-2 h-3.5 w-3.5" aria-hidden />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="mr-2 h-3.5 w-3.5" aria-hidden />
                            Activate
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => runSourceMutation.mutate(source.id)}
                        disabled={runSourceMutation.isPending}
                      >
                        {runSourceMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <>
                            <RefreshCcw className="mr-2 h-3.5 w-3.5" aria-hidden />
                            Run now
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="border-muted/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <ActivitySquare className="h-4 w-4" aria-hidden />
            Recent activity
          </CardTitle>
          <CardDescription>System-generated notes from discovery runs and crawler updates.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" description="Trigger a run to populate the discovery log." />
          ) : (
            activity.map((entry) => <ActivityRow key={entry.id} entry={entry} />)
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function ActivityRow({ entry }: { entry: DiscoveryActivity }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{entry.type}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock3 className="h-3 w-3" aria-hidden />
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{entry.message ?? "Activity recorded."}</p>
    </div>
  )
}


