import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Loader2, ArrowLeft } from 'lucide-react'
import { apiFetch } from '@/api/client'
import { createPageUrl } from '@/utils'
import ProposalEditor from '@/components/proposals/ProposalEditor'

function getQueryParam(name) {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get(name)
  } catch {
    return null
  }
}

export default function Apply() {
  const grantId = getQueryParam('id') || getQueryParam('grantId')

  const { data: grant, isLoading: isLoadingGrant, error: grantError } = useQuery({
    queryKey: ['applyGrant', grantId],
    enabled: Boolean(grantId),
    queryFn: () => apiFetch(`/api/grants/${grantId}`),
  })

  const orgId = grant?.organization_id ?? null

  const { data: organization, isLoading: isLoadingOrg } = useQuery({
    queryKey: ['applyOrganization', orgId],
    enabled: Boolean(orgId),
    queryFn: () => apiFetch(`/api/organizations/${orgId}`),
  })

  if (!grantId) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-4">
          <Link to={createPageUrl('DiscoverGrants')}>
            <Button variant="outline">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
        </div>
        <p className="text-slate-700">Missing grant id.</p>
      </div>
    )
  }

  if (isLoadingGrant || (orgId && isLoadingOrg)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (grantError || !grant) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-4">
          <Link to={createPageUrl("GrantDetail", { id: grantId })}>
            <Button variant="outline">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to grant
            </Button>
          </Link>
        </div>
        <p className="text-slate-700">Failed to load grant.</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Apply / Submission Engine</h1>
          <p className="text-sm text-slate-600">{grant.title}</p>
        </div>
        <Link to={createPageUrl("GrantDetail", { id: grantId })}>
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to grant
          </Button>
        </Link>
      </div>

      <ProposalEditor grant={grant} organization={organization ?? (orgId ? { id: orgId, name: 'Organization' } : null)} />
    </div>
  )
}

