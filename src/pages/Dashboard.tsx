import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  addDays,
  format,
  isAfter,
  isBefore,
  isValid,
  parseISO,
  differenceInCalendarDays,
} from 'date-fns'
import {
  Building2,
  Briefcase,
  DollarSign,
  CalendarDays,
  AlarmClock,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import { base44, type Organization, type Grant, type Milestone, type Expense } from '../api/base44Client'
import { AnyaStatusPanel } from '../components/anya/AnyaStatusPanel'

type CardProps = {
  className?: string
  children?: ReactNode
}

type ButtonVariant = 'default' | 'outline'

type ButtonProps = {
  to?: string
  onClick?: () => void
  children: ReactNode
  className?: string
  variant?: ButtonVariant
}

type BadgeVariant = 'default' | 'warning' | 'success' | 'neutral'

type BadgeProps = {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}

function Card({ className = '', children }: CardProps) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>
}

function CardHeader({ className = '', children }: CardProps) {
  return <div className={`flex items-start justify-between gap-2 border-b border-slate-100 px-6 py-4 ${className}`}>{children}</div>
}

function CardTitle({ className = '', children }: CardProps) {
  return <h3 className={`text-lg font-semibold text-slate-900 ${className}`}>{children}</h3>
}

function CardContent({ className = '', children }: CardProps) {
  return <div className={`px-6 py-4 ${className}`}>{children}</div>
}

function Button({ to, onClick, children, className = '', variant = 'default' }: ButtonProps) {
  const baseStyles = 'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition'
  const variants: Record<ButtonVariant, string> = {
    default: 'bg-slate-900 text-white hover:bg-slate-800',
    outline: 'border border-slate-200 text-slate-700 hover:bg-slate-50',
  }

  if (to) {
    return (
      <Link to={to} className={`${baseStyles} ${variants[variant]} ${className}`} onClick={onClick}>
        {children}
      </Link>
    )
  }

  return (
    <button type="button" className={`${baseStyles} ${variants[variant]} ${className}`} onClick={onClick}>
      {children}
    </button>
  )
}

function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  const variants: Record<BadgeVariant, string> = {
    default: 'bg-slate-900 text-white',
    warning: 'bg-amber-100 text-amber-800',
    success: 'bg-emerald-100 text-emerald-800',
    neutral: 'bg-slate-100 text-slate-600',
  }

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${variants[variant]} ${className}`}>{children}</span>
}

interface QuickStats {
  discovered: number
  inProgress: number
  submitted: number
  awarded: number
}

const ACTIVE_GRANT_STATUSES = new Set<Grant['status']>(['interested', 'drafting', 'submitted', 'awarded'])
const UPCOMING_DEADLINE_STATUSES = new Set<Grant['status']>(['discovered', 'interested', 'drafting'])

type ParsedDate = Date | 'rolling' | undefined

function toDate(value?: string | null): ParsedDate {
  if (!value || typeof value !== 'string') return undefined
  if (value.toLowerCase() === 'rolling') return 'rolling'
  const parsed = parseISO(value)
  return isValid(parsed) ? parsed : undefined
}

export default function Dashboard() {
  const organizationsQuery = useQuery<Organization[]>({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
  })

  const grantsQuery = useQuery<Grant[]>({
    queryKey: ['grants'],
    queryFn: () => base44.entities.Grant.list('-created_date'),
  })

  const milestonesQuery = useQuery<Milestone[]>({
    queryKey: ['milestones'],
    queryFn: () => base44.entities.Milestone.list('due_date'),
  })

  const expensesQuery = useQuery<Expense[]>({
    queryKey: ['expenses'],
    queryFn: () => base44.entities.Expense.list('-date'),
  })

  const isLoading =
    organizationsQuery.isLoading || grantsQuery.isLoading || milestonesQuery.isLoading || expensesQuery.isLoading

  const isError = organizationsQuery.isError || grantsQuery.isError || milestonesQuery.isError || expensesQuery.isError

  const organizations = organizationsQuery.data ?? []
  const grants = grantsQuery.data ?? []
  const milestones = milestonesQuery.data ?? []
  const expenses = expensesQuery.data ?? []

  const now = new Date()

  const totalExpenses = useMemo(
    () => expenses.reduce((sum, item) => sum + (typeof item.amount === 'number' ? item.amount : Number(item.amount) || 0), 0),
    [expenses],
  )

  const activeGrants = useMemo(() => grants.filter((grant) => ACTIVE_GRANT_STATUSES.has(grant.status)), [grants])

  const upcomingDeadlineGrants = useMemo(() => {
    return grants.filter((grant) => {
      if (!UPCOMING_DEADLINE_STATUSES.has(grant.status)) return false
      const deadline = toDate(grant.deadline)
      if (!deadline) return false
      if (deadline === 'rolling') return true
      return isAfter(deadline, now) && isBefore(deadline, addDays(now, 14))
    })
  }, [grants, now])

  const urgentDeadlines = useMemo(() => {
    return grants
      .filter((grant) => {
        if (!UPCOMING_DEADLINE_STATUSES.has(grant.status)) return false
        const deadline = toDate(grant.deadline)
        if (!deadline || deadline === 'rolling') return false
        return isAfter(deadline, now) && isBefore(deadline, addDays(now, 7))
      })
      .sort((a, b) => {
        const aDate = toDate(a.deadline)
        const bDate = toDate(b.deadline)
        if (aDate === 'rolling' || bDate === 'rolling' || !aDate || !bDate) return 0
        return aDate.getTime() - bDate.getTime()
      })
      .slice(0, 5)
  }, [grants, now])

  const upcomingMilestones = useMemo(
    () =>
      milestones
        .map((milestone) => ({ milestone, parsed: toDate(milestone.due_date) }))
        .filter((entry): entry is { milestone: Milestone; parsed: Date } => entry.parsed instanceof Date && isAfter(entry.parsed, now))
        .sort((a, b) => a.parsed.getTime() - b.parsed.getTime())
        .slice(0, 5),
    [milestones, now],
  )

  const recentGrants = useMemo(() => grants.slice(0, 5), [grants])

  const quickStats: QuickStats = useMemo(() => {
    const discovered = grants.filter((grant) => grant.status === 'discovered').length
    const inProgress = grants.filter((grant) => grant.status === 'interested' || grant.status === 'drafting').length
    const submitted = grants.filter((grant) => grant.status === 'submitted').length
    const awarded = grants.filter((grant) => grant.status === 'awarded').length

    return { discovered, inProgress, submitted, awarded }
  }, [grants])

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        <header>
          <div className="h-10 w-64 animate-pulse rounded-lg bg-slate-200" />
          <div className="mt-2 h-4 w-96 animate-pulse rounded bg-slate-200" />
        </header>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white" />
          ))}
        </div>
      </main>
    )
  }

  if (isError) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>We ran into a problem loading your data.</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600">
              Please refresh the page or try again later. If the issue persists, contact support.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  const hasOrganizations = organizations.length > 0

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Grant Operations Dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Get an at-a-glance view of grant activity, upcoming milestones, and budget performance across your
            portfolio.
          </p>
        </div>
        <Button to="/organizations" className="w-full sm:w-auto">
          Manage organizations
          <ArrowRight className="h-4 w-4" />
        </Button>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="relative overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Organizations</CardTitle>
              <p className="text-sm text-slate-500">Active relationships in your pipeline</p>
            </div>
            <div className="rounded-full bg-slate-900/10 p-2 text-slate-900">
              <Building2 className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-900">{organizations.length}</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Active Grants</CardTitle>
              <p className="text-sm text-slate-500">Interested, drafting, submitted, or awarded</p>
            </div>
            <div className="rounded-full bg-slate-900/10 p-2 text-slate-900">
              <Briefcase className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-900">{activeGrants.length}</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Total Expenses</CardTitle>
              <p className="text-sm text-slate-500">Across all tracked grants</p>
            </div>
            <div className="rounded-full bg-slate-900/10 p-2 text-slate-900">
              <DollarSign className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-900">${totalExpenses.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Upcoming Deadlines</CardTitle>
              <p className="text-sm text-slate-500">Next 14 days or rolling opportunities</p>
            </div>
            <div className="rounded-full bg-slate-900/10 p-2 text-slate-900">
              <CalendarDays className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-slate-900">{upcomingDeadlineGrants.length}</p>
          </CardContent>
        </Card>
      </section>

      <div className="mt-8">
        <AnyaStatusPanel />
      </div>
      {!hasOrganizations && (
        <Card className="border-dashed bg-slate-50">
          <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-slate-800">
                <Sparkles className="h-5 w-5 text-slate-500" />
                Get started by adding your first organization
              </CardTitle>
              <p className="mt-2 max-w-2xl text-sm text-slate-600">
                Track partner relationships, monitor activity, and collaborate with your team in one central workspace.
              </p>
            </div>
            <Button to="/organizations" variant="outline">
              Add organization
              <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="border-none">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlarmClock className="h-5 w-5 text-amber-500" />
                  Urgent Deadlines
                </CardTitle>
                <p className="text-sm text-slate-500">Deadlines in the next 7 days</p>
              </div>
              <Badge variant="warning">{urgentDeadlines.length} approaching</Badge>
            </CardHeader>
            <CardContent>
              {urgentDeadlines.length === 0 ? (
                <p className="text-sm text-slate-500">No deadlines in the next week. Stay proactive!</p>
              ) : (
                <ul className="space-y-4">
                  {urgentDeadlines.map((grant) => {
                    const deadline = toDate(grant.deadline)
                    const deadlineLabel =
                      deadline && deadline !== 'rolling'
                        ? format(deadline, 'MMM d, yyyy')
                        : 'Rolling deadline'
                    const daysAway =
                      deadline && deadline !== 'rolling' ? differenceInCalendarDays(deadline, now) : undefined

                    return (
                      <li key={grant.id} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-slate-800">{grant.name}</p>
                          <p className="text-sm text-slate-500">{deadlineLabel}</p>
                        </div>
                        <Badge variant="warning">
                          {daysAway !== undefined ? `${daysAway} day${daysAway === 1 ? '' : 's'}` : 'Rolling'}
                        </Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-none">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CalendarDays className="h-5 w-5 text-slate-600" />
                  Upcoming Milestones
                </CardTitle>
                <p className="text-sm text-slate-500">Stay on top of critical grant activities</p>
              </div>
            </CardHeader>
            <CardContent>
              {upcomingMilestones.length === 0 ? (
                <p className="text-sm text-slate-500">No upcoming milestones. Consider scheduling next steps.</p>
              ) : (
                <ul className="space-y-4">
                  {upcomingMilestones.map(({ milestone, parsed }) => {
                    return (
                      <li key={milestone.id} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-slate-800">{milestone.title}</p>
                          <p className="text-sm text-slate-500">{milestone.grant}</p>
                        </div>
                        <Badge variant="neutral">{format(parsed, 'MMM d')}</Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="border-none">
              <div>
                <CardTitle>Recent Grants</CardTitle>
                <p className="text-sm text-slate-500">Latest activity across your pipeline</p>
              </div>
            </CardHeader>
            <CardContent>
              {recentGrants.length === 0 ? (
                <p className="text-sm text-slate-500">Once you add grants, they’ll show up here.</p>
              ) : (
                <ul className="space-y-4">
                  {recentGrants.map((grant) => {
                    const createdDate = grant.created_date ? toDate(grant.created_date) : undefined
                    return (
                      <li key={grant.id} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-slate-800">{grant.name}</p>
                          <p className="text-sm text-slate-500">
                            {grant.organization} • {grant.status}
                          </p>
                        </div>
                        <Badge variant="neutral">
                          {createdDate && createdDate !== 'rolling' ? format(createdDate, 'MMM d') : 'New'}
                        </Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-none">
              <div>
                <CardTitle>Quick Stats</CardTitle>
                <p className="text-sm text-slate-500">Snapshot of grant pipeline health</p>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-slate-500">Discovered</dt>
                  <dd className="text-sm font-semibold text-slate-900">{quickStats.discovered}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-slate-500">In Progress</dt>
                  <dd className="text-sm font-semibold text-slate-900">{quickStats.inProgress}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-slate-500">Submitted</dt>
                  <dd className="text-sm font-semibold text-slate-900">{quickStats.submitted}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-slate-500">Awarded</dt>
                  <dd className="text-sm font-semibold text-slate-900">{quickStats.awarded}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  )
}


