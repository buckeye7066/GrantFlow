import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addDays,
  differenceInCalendarDays,
  format,
  isAfter,
  isBefore,
  isValid,
  parseISO,
} from "date-fns"
import {
  AlarmClock,
  ArrowRight,
  BarChart3,
  Briefcase,
  Building2,
  CalendarDays,
  DollarSign,
  PlusCircle,
  Sparkles,
  Target,
} from "lucide-react"
import { base44, type Organization, type Grant, type Milestone, type Expense } from "../api/base44Client"
import { AnyaStatusPanel } from "../components/anya/AnyaStatusPanel"
import { Button } from "../components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card"
import { Badge } from "../components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../components/ui/dialog"
import { LoadingState } from "../components/LoadingState"
import { ErrorState } from "../components/ErrorState"
import { EmptyState } from "../components/EmptyState"

interface QuickStats {
  discovered: number
  inProgress: number
  submitted: number
  awarded: number
}

const ACTIVE_GRANT_STATUSES = new Set<Grant["status"]>(["interested", "drafting", "submitted", "awarded"])
const UPCOMING_DEADLINE_STATUSES = new Set<Grant["status"]>(["discovered", "interested", "drafting"])

type ParsedDate = Date | "rolling" | undefined

function toDate(value?: string | null): ParsedDate {
  if (!value || typeof value !== "string") return undefined
  if (value.toLowerCase() === "rolling") return "rolling"
  const parsed = parseISO(value)
  return isValid(parsed) ? parsed : undefined
}

export default function Dashboard() {
  const queryClient = useQueryClient()

  const organizationsQuery = useQuery<Organization[]>({
    queryKey: ["organizations"],
    queryFn: () => base44.entities.Organization.list(),
  })

  const grantsQuery = useQuery<Grant[]>({
    queryKey: ["grants"],
    queryFn: () => base44.entities.Grant.list(),
  })

  const milestonesQuery = useQuery<Milestone[]>({
    queryKey: ["milestones"],
    queryFn: () => base44.entities.Milestone.list(),
  })

  const expensesQuery = useQuery<Expense[]>({
    queryKey: ["expenses"],
    queryFn: () => base44.entities.Expense.list(),
  })

  const isLoading =
    organizationsQuery.isLoading || grantsQuery.isLoading || milestonesQuery.isLoading || expensesQuery.isLoading

  const isError =
    organizationsQuery.isError || grantsQuery.isError || milestonesQuery.isError || expensesQuery.isError

  const organizations = useMemo(() => organizationsQuery.data ?? [], [organizationsQuery.data])
  const grants = useMemo(() => grantsQuery.data ?? [], [grantsQuery.data])
  const milestones = useMemo(() => milestonesQuery.data ?? [], [milestonesQuery.data])
  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])

  const totalExpenses = useMemo(
    () => expenses.reduce((sum, item) => sum + (typeof item.amount === "number" ? item.amount : Number(item.amount) || 0), 0),
    [expenses],
  )

  const activeGrants = useMemo(() => grants.filter((grant) => ACTIVE_GRANT_STATUSES.has(grant.status)), [grants])

  const upcomingDeadlineGrants = useMemo(() => {
    const now = new Date()
    return grants.filter((grant) => {
      if (!UPCOMING_DEADLINE_STATUSES.has(grant.status)) return false
      const deadline = toDate(grant.deadline)
      if (!deadline) return false
      if (deadline === "rolling") return true
      return isAfter(deadline, now) && isBefore(deadline, addDays(now, 14))
    })
  }, [grants])

  const urgentDeadlines = useMemo(() => {
    const now = new Date()
    return grants
      .filter((grant) => {
        if (!UPCOMING_DEADLINE_STATUSES.has(grant.status)) return false
        const deadline = toDate(grant.deadline)
        if (!deadline || deadline === "rolling") return false
        return isAfter(deadline, now) && isBefore(deadline, addDays(now, 7))
      })
      .sort((a, b) => {
        const aDate = toDate(a.deadline)
        const bDate = toDate(b.deadline)
        if (aDate === "rolling" || bDate === "rolling" || !aDate || !bDate) return 0
        return aDate.getTime() - bDate.getTime()
      })
      .slice(0, 5)
  }, [grants])

  const upcomingMilestones = useMemo(
    () =>
      milestones
        .map((milestone) => ({ milestone, parsed: toDate(milestone.due_date) }))
        .filter((entry): entry is { milestone: Milestone; parsed: Date } => {
          if (!(entry.parsed instanceof Date)) return false
          return isAfter(entry.parsed, new Date())
        })
        .sort((a, b) => a.parsed.getTime() - b.parsed.getTime())
        .slice(0, 5),
    [milestones],
  )

  const recentGrants = useMemo(() => grants.slice(0, 5), [grants])

  const quickStats: QuickStats = useMemo(() => {
    const discovered = grants.filter((grant) => grant.status === "discovered").length
    const inProgress = grants.filter((grant) => grant.status === "interested" || grant.status === "drafting").length
    const submitted = grants.filter((grant) => grant.status === "submitted").length
    const awarded = grants.filter((grant) => grant.status === "awarded").length

    return { discovered, inProgress, submitted, awarded }
  }, [grants])

  const handleRetry = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations"] }),
      queryClient.invalidateQueries({ queryKey: ["grants"] }),
      queryClient.invalidateQueries({ queryKey: ["milestones"] }),
      queryClient.invalidateQueries({ queryKey: ["expenses"] }),
    ])
  }

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl space-y-8 p-6">
        <LoadingState label="Gathering the latest grant intelligenceâ€¦" />
      </main>
    )
  }

  if (isError) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <ErrorState onRetry={handleRetry} />
      </main>
    )
  }

  const hasOrganizations = organizations.length > 0

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <section className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Badge variant="secondary" className="w-fit uppercase tracking-wide">
            Operations overview
          </Badge>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Grant Operations Dashboard</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Monitor relationships, track commitments, and stay ahead of upcoming deadlines from a single command center.
          </p>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Button asChild>
            <Link to="/organizations">
              Manage organizations
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/organizations">
              Add quick note
              <PlusCircle className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Organizations</CardTitle>
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <Building2 className="h-5 w-5" aria-hidden />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <span className="text-3xl font-semibold">{organizations.length}</span>
            <CardDescription>Active partner relationships today</CardDescription>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active grants</CardTitle>
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <Briefcase className="h-5 w-5" aria-hidden />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <span className="text-3xl font-semibold">{activeGrants.length}</span>
            <CardDescription>Interested, drafting, submitted, or awarded</CardDescription>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total expenses</CardTitle>
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <DollarSign className="h-5 w-5" aria-hidden />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <span className="text-3xl font-semibold">
              ${totalExpenses.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <CardDescription>Spend recorded across all tracked grants</CardDescription>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Upcoming deadlines</CardTitle>
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <CalendarDays className="h-5 w-5" aria-hidden />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <span className="text-3xl font-semibold">{upcomingDeadlineGrants.length}</span>
            <CardDescription>Next 14 days including rolling opportunities</CardDescription>
          </CardContent>
        </Card>
      </section>

      <Card className="overflow-hidden border-none bg-card">
        <CardContent className="px-0 pb-0">
          <AnyaStatusPanel />
        </CardContent>
      </Card>

      {!hasOrganizations && (
        <EmptyState
          title="Add your first organization"
          description="Organize eligibility notes, collaborators, and grant-ready collateral in one shared profile."
          icon={<Sparkles className="h-6 w-6" aria-hidden />}
          action={
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">
                  Quick start checklist
                  <Target className="h-4 w-4" aria-hidden />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader className="space-y-3">
                  <DialogTitle>First organization setup</DialogTitle>
                  <DialogDescription>
                    Capture baseline details so GrantFlow can prefill outreach, eligibility scoring, and required documentation.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>Before your first call, gather:</p>
                  <ul className="list-disc space-y-2 pl-5 text-left">
                    <li>Mission statement and program areas (copy &amp; paste is fine)</li>
                    <li>FY budget ranges or typical ask size</li>
                    <li>Primary contact + secondary approver</li>
                    <li>Current funding priorities or focus populations</li>
                  </ul>
                </div>
                <DialogFooter className="pt-4">
                  <DialogClose asChild>
                    <Button variant="outline">Close</Button>
                  </DialogClose>
                  <Button asChild>
                    <Link to="/organizations">Open organizations workspace</Link>
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          }
          className="border border-dashed"
        />
      )}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Tabs defaultValue="deadlines" className="space-y-4">
          <Card>
            <CardHeader className="pb-0">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-primary" aria-hidden />
                    Pipeline focus
                  </CardTitle>
                  <CardDescription>Switch between time-sensitive workstreams.</CardDescription>
                </div>
                <TabsList>
                  <TabsTrigger value="deadlines">Deadlines</TabsTrigger>
                  <TabsTrigger value="milestones">Milestones</TabsTrigger>
                  <TabsTrigger value="stats">Stats</TabsTrigger>
                </TabsList>
              </div>
            </CardHeader>
            <CardContent>
              <TabsContent value="deadlines" className="mt-0">
                {urgentDeadlines.length === 0 ? (
                  <EmptyState
                    title="No urgent deadlines"
                    description="Youâ€™re clear for the next seven days. Use the time to strengthen upcoming proposals."
                    icon={<AlarmClock className="h-6 w-6" aria-hidden />}
                    className="border border-dashed bg-muted/20"
                  />
                ) : (
                  <ul className="space-y-4">
                    {urgentDeadlines.map((grant) => {
                      const deadline = toDate(grant.deadline)
                      const deadlineLabel =
                        deadline && deadline !== "rolling" ? format(deadline, "MMM d, yyyy") : "Rolling deadline"
                      const daysAway =
                        deadline && deadline !== "rolling" ? differenceInCalendarDays(deadline, new Date()) : undefined

                      return (
                        <li
                          key={grant.id}
                          className="flex flex-col gap-2 rounded-md border border-border/60 p-3 transition hover:border-border hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <p className="font-medium text-foreground">{grant.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {grant.organization} â€¢ {deadlineLabel}
                            </p>
                          </div>
                          <Badge variant="warning">
                            {daysAway !== undefined ? `${daysAway} day${daysAway === 1 ? "" : "s"}` : "Rolling"}
                          </Badge>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </TabsContent>
              <TabsContent value="milestones" className="mt-0">
                {upcomingMilestones.length === 0 ? (
                  <EmptyState
                    title="No scheduled milestones"
                    description="Log next actions for in-flight grants to keep the team aligned."
                    icon={<CalendarDays className="h-6 w-6" aria-hidden />}
                    className="border border-dashed bg-muted/20"
                  />
                ) : (
                  <ul className="space-y-4">
                    {upcomingMilestones.map(({ milestone, parsed }) => (
                      <li
                        key={milestone.id}
                        className="flex flex-col gap-2 rounded-md border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p className="font-medium text-foreground">{milestone.title}</p>
                          <p className="text-xs text-muted-foreground">{milestone.grant}</p>
                        </div>
                        <Badge variant="secondary">{format(parsed, "MMM d")}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
              <TabsContent value="stats" className="mt-0">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Card className="border bg-muted/40">
                    <CardContent className="space-y-2 px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Discovered</p>
                      <p className="text-2xl font-semibold">{quickStats.discovered}</p>
                      <p className="text-xs text-muted-foreground">Prospects awaiting scoping conversations.</p>
                    </CardContent>
                  </Card>
                  <Card className="border bg-muted/40">
                    <CardContent className="space-y-2 px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">In progress</p>
                      <p className="text-2xl font-semibold">{quickStats.inProgress}</p>
                      <p className="text-xs text-muted-foreground">Narratives or budgets currently being drafted.</p>
                    </CardContent>
                  </Card>
                  <Card className="border bg-muted/40">
                    <CardContent className="space-y-2 px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Submitted</p>
                      <p className="text-2xl font-semibold">{quickStats.submitted}</p>
                      <p className="text-xs text-muted-foreground">Awaiting funder decision.</p>
                    </CardContent>
                  </Card>
                  <Card className="border bg-muted/40">
                    <CardContent className="space-y-2 px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Awarded</p>
                      <p className="text-2xl font-semibold">{quickStats.awarded}</p>
                      <p className="text-xs text-muted-foreground">Funding secured this cycle.</p>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </CardContent>
          </Card>
        </Tabs>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>Recent grants</CardTitle>
            <CardDescription>The newest opportunities across your pipeline.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {recentGrants.length === 0 ? (
              <EmptyState
                title="No recent activity yet"
                description="As new grants are added, theyâ€™ll appear here with status and organization context."
                icon={<PlusCircle className="h-6 w-6" aria-hidden />}
                className="border border-dashed bg-muted/20"
              />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Grant</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Organization</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentGrants.map((grant) => {
                      const createdDate = grant.created_date ? toDate(grant.created_date) : undefined
                      return (
                        <TableRow key={grant.id}>
                          <TableCell className="font-medium">{grant.name}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="capitalize">
                              {grant.status.replace("-", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{grant.organization}</TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {createdDate && createdDate !== "rolling" ? format(createdDate, "MMM d") : "New"}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <TableCaption className="text-xs text-muted-foreground">
                  Sorting newest first. Use Organizations to update notes or reassign owners.
                </TableCaption>
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
