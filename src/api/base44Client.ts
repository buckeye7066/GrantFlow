import { API_BASE } from './apiBase'

// Profile interfaces
export interface Profile {
  id: string
  profile_type: string
  display_name: string
  notes: string
  created_at: string
  updated_at: string
  full_name?: string | null
  dob?: string | null
  job_title?: string | null
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  website?: string | null
  mission_statement?: string | null
  ein?: string | null
  duns?: string | null
  cage_code?: string | null
  naics_codes?: string | null
  annual_budget?: number | null
  staff_count?: number | null
  volunteer_count?: number | null
  service_area?: string | null
  demographics_served?: string | null
  program_focus_areas?: string | null
  compliance_notes?: string | null
  certifications?: string | null
  phi_access_required: boolean
  created_by?: string | null
  owner_id?: string | null
  case_manager_id?: string | null
  admin_id?: string | null
  last_contacted_at?: string | null
  status?: string | null
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonRecord = Record<string, JsonValue>

export interface Document {
  id: string
  profile_id: string
  original_filename: string
  mime_type: string
  storage_path: string
  sha256: string
  size_bytes: number
  status: 'uploaded' | 'parsing' | 'parsed' | 'applied' | 'failed'
  doc_type: string
  extracted?: {
    text: string
    classification: JsonRecord
    extracted: JsonRecord
  } | null
  suggested_patches?: JsonRecord | null
  applied_at?: string | null
  error?: string | null
  created_at: string
  updated_at: string
}

export type Opportunity = {
  id: string
  name: string
} & JsonRecord

// Legacy interfaces for backward compatibility
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

const buildApiUrl = (path: string): string => {
  const withoutApiPrefix = path.startsWith('/api') ? path.slice(4) : path
  if (!withoutApiPrefix || withoutApiPrefix === '/') {
    return API_BASE
  }
  return `${API_BASE}${withoutApiPrefix.startsWith('/') ? withoutApiPrefix : `/${withoutApiPrefix}`}`
}

// API helper function
async function apiCall<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(buildApiUrl(endpoint), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data
  }
  return payload as T
}

export const base44 = {
  profiles: {
    async list(): Promise<Profile[]> {
      return apiCall<Profile[]>('/api/profiles')
    },
    async get(id: string): Promise<Profile> {
      return apiCall<Profile>(`/api/profiles/${id}`)
    },
    async create(data: Partial<Profile>): Promise<Profile> {
      return apiCall<Profile>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(data),
      })
    },
    async update(id: string, data: Partial<Profile>): Promise<Profile> {
      return apiCall<Profile>(`/api/profiles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      })
    },
    async delete(id: string): Promise<void> {
      return apiCall<void>(`/api/profiles/${id}`, {
        method: 'DELETE',
      })
    },
  },
  documents: {
    async list(profileId: string): Promise<Document[]> {
      return apiCall<Document[]>(`/api/profiles/${profileId}/documents`)
    },
    async get(documentId: string): Promise<Document> {
      return apiCall<Document>(`/api/documents/${documentId}`)
    },
    async upload(profileId: string, file: File): Promise<Document> {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(buildApiUrl(`/api/profiles/${profileId}/documents`), {
        method: 'POST',
        body: formData,
        credentials: 'include',
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(error.error || `HTTP ${response.status}`)
      }

      return response.json()
    },
    async parse(documentId: string): Promise<Document> {
      return apiCall<Document>(`/api/documents/${documentId}/parse`, {
        method: 'POST',
      })
    },
    async apply(documentId: string): Promise<{ message: string; changes: JsonRecord }> {
      return apiCall<{ message: string; changes: JsonRecord }>(`/api/documents/${documentId}/apply`, {
        method: 'POST',
      })
    },
    async delete(documentId: string): Promise<void> {
      return apiCall<void>(`/api/documents/${documentId}`, {
        method: 'DELETE',
      })
    },
  },
  opportunities: {
    async list(): Promise<Opportunity[]> {
      return apiCall<Opportunity[]>('/api/opportunities')
    },
  },
  // Legacy entities for backward compatibility
  entities: {
    Organization: {
      async list(): Promise<Organization[]> {
        return organizationsSeed
      },
    },
    Grant: {
      async list(): Promise<Grant[]> {
        return grantsSeed
      },
    },
    Milestone: {
      async list(): Promise<Milestone[]> {
        return milestonesSeed
      },
    },
    Expense: {
      async list(): Promise<Expense[]> {
        return expensesSeed
      },
    },
  },
}

export type Base44Client = typeof base44

export function createBase44Client(): Base44Client {
  return base44
}

