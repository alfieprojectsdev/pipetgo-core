'use client'
// Client component for the accreditation upload page. Two-step upload: request presigned PUT
// URL via Server Action, PUT to R2 via browser fetch, then confirm via Server Action. (ref: DL-001)

import { useActionState, useRef, useEffect, useState } from 'react'
import { type DocumentStatus } from '@prisma/client'
import { requestUploadUrl } from './upload-action'
import { confirmUpload } from './confirm-action'
import type { AccreditationPageDTO } from './page'
import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'

// VERIFIED_BADGE is a two-value map rather than Record<KycStatus> because isVerified
// is a boolean, not an enum. Satisfies ensures exhaustive handling of both states.
const VERIFIED_BADGE: Record<'verified' | 'pending', { label: string; className: string }> = {
  verified: { label: 'Accredited',      className: 'bg-green-200 text-green-800' },
  pending:  { label: 'Pending review',  className: 'bg-yellow-200 text-yellow-800' },
}

const DOC_STATUS_BADGE = {
  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
} as const satisfies Record<DocumentStatus, { label: string; className: string }>

type UploadResult = { presignedUrl: string; r2Key: string; labDocumentId: string }
type UploadState = { message?: string } | UploadResult | null
type ConfirmState = { message?: string } | null

export function AccreditationUploadUi({ dto }: { dto: AccreditationPageDTO }) {
  const badge = dto.isVerified ? VERIFIED_BADGE.verified : VERIFIED_BADGE.pending
  const fileRef = useRef<HTMLInputElement>(null)

  const [uploadState, uploadAction, uploadPending] = useActionState(
    requestUploadUrl,
    null as UploadState,
  )
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmUpload,
    null as ConfirmState,
  )

  const [putError, setPutError] = useState<string | null>(null)

  useEffect(() => {
    if (!uploadState || !('presignedUrl' in uploadState)) return
    const result = uploadState as UploadResult
    const file = fileRef.current?.files?.[0]
    if (!file) return

    void (async () => {
      try {
        const putRes = await fetch(result.presignedUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
          signal: AbortSignal.timeout(60_000),
        })
        if (!putRes.ok) {
          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
          return
        }
        setPutError(null)

        const confirmFormData = new FormData()
        confirmFormData.set('labDocumentId', result.labDocumentId)
        void confirmAction(confirmFormData)
      } catch (err) {
        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
      }
    })()
  }, [uploadState, confirmAction])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPutError(null)
    const form = e.currentTarget
    const fileInput = fileRef.current
    if (!fileInput?.files?.[0]) return

    const file = fileInput.files[0]

    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      return
    }
    if (file.size > MAX_BYTES) {
      return
    }

    const uploadFormData = new FormData(form)
    uploadFormData.set('fileName', file.name)
    uploadFormData.set('mimeType', file.type)
    uploadFormData.set('fileSize', String(file.size))
    void uploadAction(uploadFormData)
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">ISO 17025 Accreditation</h1>
          <div className="mt-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${badge.className}`}>
              {badge.label}
            </span>
          </div>
        </div>

        {/* Rejection reason banner — shown when a previous cert was rejected so the lab
            owner knows what to correct before re-uploading. */}
        {!dto.isVerified && dto.accreditationRejectionReason && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <h2 className="text-sm font-medium text-red-800 mb-1">Accreditation Rejected</h2>
            <p className="text-sm text-red-700">{dto.accreditationRejectionReason}</p>
          </div>
        )}

        {dto.documents.length > 0 && (
          <div className="mb-6 bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Uploaded Certificates</h2>
            <ul className="divide-y divide-gray-100">
              {dto.documents.map((doc) => {
                const db = DOC_STATUS_BADGE[doc.status]
                return (
                  <li key={doc.id} className="py-2 flex items-center justify-between">
                    <span className="text-sm text-gray-800">{doc.fileName}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${db.className}`}>
                      {db.label}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {!dto.isVerified && (
          <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
            <input type="hidden" name="documentType" value="ACCREDITATION_CERTIFICATE" />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ISO 17025 Certificate (PDF, JPEG, PNG — max 20 MB)</label>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                required
                className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
              />
            </div>
            {uploadState && 'message' in uploadState && uploadState.message && (
              <p className="text-sm text-red-600">{uploadState.message}</p>
            )}
            {confirmState && 'message' in confirmState && confirmState.message && (
              <p className="text-sm text-red-600">{confirmState.message}</p>
            )}
            {putError && (
              <p className="text-sm text-red-600">{putError}</p>
            )}
            <button
              type="submit"
              disabled={uploadPending || confirmPending}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {uploadPending || confirmPending ? 'Uploading…' : 'Upload Certificate'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
