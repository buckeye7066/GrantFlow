import { useState, useEffect } from 'react'
import { Download, Printer, Save, Upload, FileText, CheckCircle, XCircle, Loader } from 'lucide-react'
import { useExperience } from '../contexts/ExperienceContext'
import { base44 } from '../api/base44Client'
import type { Profile, Document } from '../api/base44Client'

export default function Organizations() {
  const { markSaved, lastSavedLabel } = useExperience()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [notes, setNotes] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Load profiles on mount
  useEffect(() => {
    loadProfiles()
  }, [])

  // Load documents when profile changes
  useEffect(() => {
    if (selectedProfile) {
      setNotes(selectedProfile.notes || '')
      loadDocuments(selectedProfile.id)
    }
  }, [selectedProfile])

  const loadProfiles = async () => {
    try {
      setLoading(true)
      const data = await base44.profiles.list()
      setProfiles(data)
      if (data.length > 0 && !selectedProfile) {
        setSelectedProfile(data[0])
      }
    } catch (error) {
      console.error('Failed to load profiles:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadDocuments = async (profileId: string) => {
    try {
      const data = await base44.documents.list(profileId)
      setDocuments(data)
    } catch (error) {
      console.error('Failed to load documents:', error)
    }
  }

  const handleSave = async () => {
    if (!selectedProfile) return
    
    try {
      setIsSaving(true)
      await base44.profiles.update(selectedProfile.id, { notes })
      markSaved()
      // Reload to get updated timestamp
      await loadProfiles()
    } catch (error) {
      console.error('Failed to save profile:', error)
      alert('Failed to save profile')
    } finally {
      setIsSaving(false)
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedProfile || !event.target.files || event.target.files.length === 0) return

    const file = event.target.files[0]
    
    try {
      setUploading(true)
      await base44.documents.upload(selectedProfile.id, file)
      await loadDocuments(selectedProfile.id)
    } catch (error) {
      console.error('Failed to upload file:', error)
      alert(`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setUploading(false)
      // Reset file input
      event.target.value = ''
    }
  }

  const handleApplyDocument = async (documentId: string) => {
    try {
      const result = await base44.documents.apply(documentId)
      alert(`Document applied successfully!\n\n${result.message}`)
      await loadDocuments(selectedProfile!.id)
      await loadProfiles() // Reload to see updated profile data
    } catch (error) {
      console.error('Failed to apply document:', error)
      alert(`Failed to apply document: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const handlePrint = () => {
    window.print()
  }

  const handleExport = () => {
    window.print()
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'parsed':
      case 'applied':
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />
      case 'parsing':
        return <Loader className="h-5 w-5 animate-spin text-blue-500" />
      default:
        return <FileText className="h-5 w-5 text-gray-400" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'parsed':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
      case 'applied':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
      case 'failed':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      case 'parsing':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl p-6 lg:p-8">
        <div className="flex items-center justify-center py-12">
          <Loader className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <section className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Organizations</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Maintain organization profiles, notes, and upload documents for automatic data extraction.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">Last saved: {lastSavedLabel}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            <Save className="h-4 w-4" aria-hidden />
            {isSaving ? 'Saving...' : 'Save Profile (Ctrl+S)'}
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" aria-hidden />
            Print Profile
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Download className="h-4 w-4" aria-hidden />
            Export Profile PDF
          </button>
        </div>
      </section>

      {/* Profile Selector */}
      {profiles.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white/60 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <label htmlFor="profile-select" className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Select Profile
          </label>
          <select
            id="profile-select"
            value={selectedProfile?.id || ''}
            onChange={(e) => {
              const profile = profiles.find(p => p.id === e.target.value)
              setSelectedProfile(profile || null)
            }}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100"
          >
            {profiles.map(profile => (
              <option key={profile.id} value={profile.id}>
                {profile.display_name}
              </option>
            ))}
          </select>
        </section>
      )}

      {/* Profile Identity Fields */}
      {selectedProfile && (selectedProfile.full_name || selectedProfile.dob || selectedProfile.address_line1) && (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white/60 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Identity Information</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {selectedProfile.full_name && (
              <div>
                <label className="block text-sm font-medium text-slate-600 dark:text-slate-400">Full Name</label>
                <p className="mt-1 text-slate-900 dark:text-slate-100">{selectedProfile.full_name}</p>
              </div>
            )}
            {selectedProfile.dob && (
              <div>
                <label className="block text-sm font-medium text-slate-600 dark:text-slate-400">Date of Birth</label>
                <p className="mt-1 text-slate-900 dark:text-slate-100">{selectedProfile.dob}</p>
              </div>
            )}
            {selectedProfile.address_line1 && (
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-slate-600 dark:text-slate-400">Address</label>
                <p className="mt-1 text-slate-900 dark:text-slate-100">
                  {selectedProfile.address_line1}
                  {selectedProfile.address_line2 && <><br />{selectedProfile.address_line2}</>}
                  {(selectedProfile.city || selectedProfile.state || selectedProfile.zip) && (
                    <><br />{[selectedProfile.city, selectedProfile.state, selectedProfile.zip].filter(Boolean).join(', ')}</>
                  )}
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Profile Notes */}
      <section className="space-y-6 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Profile Notes</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Jot quick notes about conversations, eligibility, and next steps. Everything you save here will be included when
          you print or export the profile.
        </p>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add notes about this organization..."
          className="h-40 w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/40"
        />
        <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
          <span>{notes.length} characters</span>
          <span>Autosave available via Ctrl+S</span>
        </div>
      </section>

      {/* Document Upload & Management */}
      {selectedProfile && (
        <section className="space-y-6 rounded-2xl border border-slate-200 bg-white/60 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Documents</h2>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700">
              <Upload className="h-4 w-4" aria-hidden />
              {uploading ? 'Uploading...' : 'Upload Document'}
              <input
                type="file"
                className="hidden"
                onChange={handleFileUpload}
                disabled={uploading}
                accept=".pdf,.docx,.jpg,.jpeg,.png"
              />
            </label>
          </div>
          
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Upload documents (PDF, DOCX, JPG/JPEG/PNG) to automatically extract information. Supported documents include driver's licenses, scholarship letters, and more.
          </p>

          {documents.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed border-slate-200 p-8 text-center dark:border-slate-700">
              <FileText className="mx-auto h-12 w-12 text-slate-400" />
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No documents uploaded yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map(doc => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/40"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {getStatusIcon(doc.status)}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900 dark:text-slate-100">{doc.original_filename}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${getStatusColor(doc.status)}`}>
                          {doc.status}
                        </span>
                        {doc.doc_type && doc.doc_type !== 'unknown' && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {doc.doc_type.replace('_', ' ')}
                          </span>
                        )}
                        {doc.error && (
                          <span className="text-xs text-red-600 dark:text-red-400" title={doc.error}>
                            Error occurred
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {doc.status === 'parsed' && doc.suggested_patches && (
                    <button
                      type="button"
                      onClick={() => handleApplyDocument(doc.id)}
                      className="ml-4 inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Apply
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  )
}
