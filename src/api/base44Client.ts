export interface Organization {
  id: string
  name: string
  status: 'discovered' | 'interested' | 'drafting' | 'submitted' | 'awarded' | 'inactive'
  next_deadline?: string | null
  created_date?: string
}

export interface Grant {
  id: string
  name: string
  status: 'discovered' | 'interested' | 'drafting' | 'submitted' | 'awarded'
  deadline?: string | null
  created_date?: string
  organization?: string
}

export interface Milestone {
  id: string
  title: string
  due_date: string
  grant?: string
  status?: 'upcoming' | 'completed' | 'overdue'
}

export interface Expense {
  id: string
  description: string
  amount: number
  date: string
  grant?: string
}

const organizationsSeed: Organization[] = [
  {
    id: 'org-1',
    name: 'River Valley Education Fund',
    status: 'submitted',
    next_deadline: new Date().toISOString(),
    created_date: new Date().toISOString(),
  },
  {
    id: 'org-2',
    name: 'Community Health Partners',
    status: 'drafting',
    next_deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5).toISOString(),
    created_date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
  },
]

const grantsSeed: Grant[] = [
  {
    id: 'grant-1',
    name: 'STEM Access Expansion',
    status: 'submitted',
    deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(),
    created_date: new Date().toISOString(),
    organization: 'River Valley Education Fund',
  },
  {
    id: 'grant-2',
    name: 'Clean Water Initiative',
    status: 'interested',
    deadline: 'rolling',
    created_date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    organization: 'Community Health Partners',
  },
  {
    id: 'grant-3',
    name: 'Youth Leadership Program',
    status: 'drafting',
    deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(),
    created_date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4).toISOString(),
    organization: 'River Valley Education Fund',
  },
  {
    id: 'grant-4',
    name: 'Community Garden Expansion',
    status: 'discovered',
    deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 20).toISOString(),
    created_date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString(),
    organization: 'Community Health Partners',
  },
]

const milestonesSeed: Milestone[] = [
  {
    id: 'milestone-1',
    title: 'Draft Narrative Review',
    due_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 6).toISOString(),
    grant: 'STEM Access Expansion',
    status: 'upcoming',
  },
  {
    id: 'milestone-2',
    title: 'Budget Approval Meeting',
    due_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 12).toISOString(),
    grant: 'Youth Leadership Program',
    status: 'upcoming',
  },
]

const expensesSeed: Expense[] = [
  {
    id: 'expense-1',
    description: 'Research consultant fee',
    amount: 1200,
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    grant: 'STEM Access Expansion',
  },
  {
    id: 'expense-2',
    description: 'Printing costs',
    amount: 320,
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
    grant: 'Community Garden Expansion',
  },
  {
    id: 'expense-3',
    description: 'Travel for site visit',
    amount: 540,
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    grant: 'Clean Water Initiative',
  },
]

export const base44 = {
  entities: {
    Organization: {
      async list() {
        return organizationsSeed
      },
    },
    Grant: {
      async list(_sort: string) {
        return grantsSeed
      },
    },
    Milestone: {
      async list(_sort: string) {
        return milestonesSeed
      },
    },
    Expense: {
      async list(_sort: string) {
        return expensesSeed
      },
    },
  },
}

export type Base44Client = typeof base44

export function createBase44Client(): Base44Client {
  return base44
}

