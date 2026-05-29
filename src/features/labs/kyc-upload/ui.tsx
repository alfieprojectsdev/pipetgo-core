'use client'

import { useActionState, useRef, useEffect } from 'react'
import { type KycStatus, type DocumentStatus } from '@prisma/client'
import { requestUploadUrl } from './upload-action'
import { confirmUpload } from './confirm-action'
import type { KycPageDTO } from './page'
import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/r2'

const STATUS_BADGE = {
  PENDING:   { label: 'Not started',     className: 'bg-gray-200 text-gray-700' },
  SUBMITTED: { label: 'Pending review',  className: 'bg-yellow-200 text-yellow-800' },
  APPROVED:  { label: 'Verified',        className: 'bg-green-200 text-green-800' },
  REJECTED:  { label: 'Rejected',        className: 'bg-red-200 text-red-700' },
} as const satisfies Record<KycStatus, { label: string; className: string }>

const DOC_STATUS_BADGE = {
  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
} as const satisfies Record<DocumentStatus, { label: string; className: string }>

type UploadResult = { presignedUrl: string; r2Key: string; labDocumentId: string }
type UploadState = { message?: string } | UploadResult | null
type ConfirmState = { message?: string } | null

export function KycUploadUi({ dto }: { dto: KycPageDTO }) {
  const badge = STATUS_BADGE[dto.kycStatus]
  const fileRef = useRef<HTMLInputElement>(null)

  const [uploadState, uploadAction, uploadPending] = useActionState(
    requestUploadUrl,
    null as UploadState,
  )
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmUpload,
    null as ConfirmState,
  )

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
        if (!putRes.ok) return

        const confirmFormData = new FormData()
        confirmFormData.set('labDocumentId', result.labDocumentId)
        void confirmAction(confirmFormData)
      } catch {
        // upload timed out or failed; orphan LabDocument row is swept by future GC
      }
    })()
  }, [uploadState, confirmAction])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
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
          <h1 className="text-2xl font-bold text-gray-900">KYC Verification</h1>
          <div className="mt-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${badge.className}`}>
              {badge.label}
            </span>
          </div>
        </div>

        {dto.documents.length > 0 && (
          <div className="mb-6 bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Uploaded Documents</h2>
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

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document type</label>
            <select name="documentType" required className="w-full border rounded-md px-3 py-2 text-sm">
              <option value="BIR_2303">BIR Form 2303 (Certificate of Registration)</option>
              <option value="DTI_SEC">DTI / SEC Registration</option>
              <option value="OTHER">Other supporting document</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">File (PDF, JPEG, PNG — max 20 MB)</label>
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
          <button
            type="submit"
            disabled={uploadPending || confirmPending}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {uploadPending || confirmPending ? 'Uploading…' : 'Upload Document'}
          </button>
        </form>
      </div>
    </div>
  )
}
