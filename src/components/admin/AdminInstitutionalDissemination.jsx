import React, { useState } from 'react'
import { Download, Loader2, Mail } from 'lucide-react'

import { buildInstitutionalNewsletterBundle } from '@/api/institutionalDissemination'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { downloadGeneratedFile } from '@/utils/downloadGeneratedFile'

function parseRecords(value, label) {
  let parsed
  try {
    parsed = JSON.parse(value || '[]')
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`)
  return parsed
}

export default function AdminInstitutionalDissemination() {
  const [institutionName, setInstitutionName] = useState('')
  const [editionDate, setEditionDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [groups, setGroups] = useState('[]')
  const [recipients, setRecipients] = useState('[]')
  const [opportunities, setOpportunities] = useState('[]')
  const [bundle, setBundle] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleBuild() {
    setLoading(true)
    setError('')
    try {
      const result = await buildInstitutionalNewsletterBundle({
        institutionName,
        editionDate,
        groups: parseRecords(groups, 'Groups'),
        recipients: parseRecords(recipients, 'Recipients'),
        opportunities: parseRecords(opportunities, 'Opportunities'),
      })
      setBundle(result)
    } catch (err) {
      setBundle(null)
      setError(err?.message || 'Could not build the newsletter bundle.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" /> Institutional newsletters</CardTitle>
        <CardDescription>
          Create group-specific HTML, text, and consent-scoped recipient files. This tool exports files; it does not send messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="newsletter-institution">Institution name</Label>
            <Input id="newsletter-institution" value={institutionName} onChange={(event) => setInstitutionName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newsletter-date">Edition date</Label>
            <Input id="newsletter-date" type="date" value={editionDate} onChange={(event) => setEditionDate(event.target.value)} />
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          {[
            ['Groups', groups, setGroups, '[{"id":"health-faculty","name":"Health Faculty","recipient_profile_ids":["profile-id"],"topic_terms":["rural health"]}]'],
            ['Recipients', recipients, setRecipients, '[{"profile_id":"profile-id","email":"person@institution.edu","email_opt_in":true,"email_consent_at":"2026-08-01T12:00:00Z"}]'],
            ['Opportunities', opportunities, setOpportunities, '[{"id":"opportunity-id","title":"Rural Health Award","application_url":"https://funder.example/apply","deadline":"2026-11-01","topics":["rural health"]}]'],
          ].map(([label, value, setter, placeholder]) => (
            <div key={label} className="space-y-2">
              <Label htmlFor={`newsletter-${label.toLowerCase()}`}>{label} JSON</Label>
              <Textarea
                id={`newsletter-${label.toLowerCase()}`}
                value={value}
                placeholder={placeholder}
                onChange={(event) => setter(event.target.value)}
                className="min-h-48 font-mono text-xs"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-600">
          Recipient rows without explicit email opt-in, a consent timestamp, and a deliverable address are automatically suppressed.
        </p>
        <Button onClick={handleBuild} disabled={loading || !institutionName.trim() || !editionDate}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
          Build newsletter files
        </Button>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {bundle ? (
          <div className="space-y-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-900">
              {bundle.editions?.length || 0} editions · {bundle.eligible_recipient_count || 0} eligible recipients · {bundle.suppressed_recipients?.length || 0} suppressed
            </p>
            <div className="flex flex-wrap gap-2">
              {(bundle.files || []).map((file) => (
                <Button key={file.name} size="sm" variant="outline" onClick={() => downloadGeneratedFile(file)}>
                  <Download className="mr-2 h-3.5 w-3.5" /> {file.name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
