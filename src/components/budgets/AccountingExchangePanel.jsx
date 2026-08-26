import React, { useState } from 'react'
import { Download, FileCheck2, Loader2, RefreshCw, Upload } from 'lucide-react'

import { exportGrantAccounting, reconcileGrantAccounting } from '@/api/accountingExchange'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { downloadGeneratedFile } from '@/utils/downloadGeneratedFile'

const PROVIDERS = [
  { value: 'generic', label: 'Generic ledger CSV' },
  { value: 'quickbooks', label: 'QuickBooks CSV' },
  { value: 'xero', label: 'Xero CSV' },
]

export default function AccountingExchangePanel({ grantId }) {
  const [provider, setProvider] = useState('generic')
  const [currency, setCurrency] = useState('USD')
  const [bundle, setBundle] = useState(null)
  const [importFile, setImportFile] = useState(null)
  const [reconciliation, setReconciliation] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [error, setError] = useState('')

  async function handleExport() {
    setExporting(true)
    setError('')
    try {
      const result = await exportGrantAccounting(grantId, { provider, currency })
      setBundle(result)
    } catch (err) {
      setError(err?.message || 'Could not build the accounting export.')
    } finally {
      setExporting(false)
    }
  }

  async function handleReconcile() {
    if (!importFile) return
    setReconciling(true)
    setError('')
    try {
      if (importFile.size > 5 * 1024 * 1024) throw new Error('Choose a CSV file no larger than 5 MB.')
      const csv = await importFile.text()
      const result = await reconcileGrantAccounting(grantId, { provider, csv })
      setReconciliation(result)
    } catch (err) {
      setError(err?.message || 'Could not reconcile the accounting file.')
    } finally {
      setReconciling(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Accounting export</CardTitle>
          <CardDescription>
            Build credential-free CSV files for your accounting system. GrantFlow never uploads them to a provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="accounting-provider">Format</Label>
              <Select value={provider} onValueChange={(value) => { setProvider(value); setBundle(null); setReconciliation(null) }}>
                <SelectTrigger id="accounting-provider"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="accounting-currency">Currency</Label>
              <Input
                id="accounting-currency"
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              />
            </div>
          </div>
          <Button onClick={handleExport} disabled={exporting || currency.length !== 3}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Build export
          </Button>
          {bundle ? (
            <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                <FileCheck2 className="h-4 w-4" />
                {bundle.row_counts?.budgets ?? 0} budget lines and {bundle.row_counts?.expenses ?? 0} expenses
              </div>
              <p className="text-xs text-emerald-800">
                Budget {Number(bundle.totals?.budget || 0).toLocaleString()} · Expenses {Number(bundle.totals?.expenses || 0).toLocaleString()}
              </p>
              <div className="flex flex-wrap gap-2">
                {(bundle.files || []).map((file) => (
                  <Button key={file.name} size="sm" variant="outline" onClick={() => downloadGeneratedFile(file)}>
                    <Download className="mr-2 h-3.5 w-3.5" />
                    {file.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reconcile an export</CardTitle>
          <CardDescription>
            Compare a provider CSV with GrantFlow expenses by durable external ID. This check is read-only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="accounting-import">Provider CSV</Label>
            <Input
              id="accounting-import"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => { setImportFile(event.target.files?.[0] || null); setReconciliation(null) }}
            />
          </div>
          <Button variant="outline" onClick={handleReconcile} disabled={!importFile || reconciling}>
            {reconciling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Reconcile CSV
          </Button>
          {reconciliation ? (
            <div className="rounded-lg border bg-slate-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Upload className="h-4 w-4" /> Reconciliation results
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                {Object.entries(reconciliation.counts || {}).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs capitalize text-slate-500">{key.replace(/_/g, ' ')}</dt>
                    <dd className="font-semibold text-slate-900">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>
    </div>
  )
}
