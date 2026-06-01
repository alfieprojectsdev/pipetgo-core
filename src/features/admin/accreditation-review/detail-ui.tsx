// Detail UI for admin/accreditation-review. Verify and reject forms are separate HTML
// form elements sharing the same verifyOrRejectAccreditation action — decision is passed
// via a hidden 'decision' input. Both forms disabled while the other is pending.
'use client'

import { useActionState, useTransition, useState } from 'react'
import { type DocumentStatus } from '@prisma/client'
import { verifyOrRejectAccreditation } from './action'
import { viewAccreditationDocument } from './view-document-action'
import type { LabAccreditationDetailDTO } from './detail-page'

// DOC_STATUS_BADGE copied from labs/ slice — VSA prohibits cross-slice UI imports.
// satisfies Record<DocumentStatus,…> makes a missing enum member a compile-time error. (ref: DL-009)
const DOC_STATUS_BADGE = {
  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
} as const satisfies Record<DocumentStatus, { label: string; className: string }>

/**
 * Mints a presigned GET URL on click via viewAccreditationDocument and opens it in a new tab.
 * URL is not pre-fetched — each click triggers a fresh Server Action call that re-checks
 * ADMIN role and binds a new 300s TTL. (ref: DL-004)
 */
function ViewDocumentButton({ docId, fileName }: { docId: string; fileName: string }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    setError(null)
    startTransition(async () => {
      const result = await viewAccreditationDocument(docId)
      if ('url' in result) {
        window.open(result.url, '_blank', 'noopener,noreferrer')
      } else {
        setError(result.message ?? 'Unable to open document.')
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="text-blue-600 hover:text-blue-800 text-sm font-medium disabled:opacity-50"
      >
        {isPending ? 'Loading…' : `View ${fileName}`}
      </button>
      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}
    </div>
  )
}

export function AdminAccreditationDetailUi({ dto }: { dto: LabAccreditationDetailDTO }) {
  const [verifyState, verifyAction, verifyPending] = useActionState(
    verifyOrRejectAccreditation,
    null,
  )
  const [rejectState, rejectAction, rejectPending] = useActionState(
    verifyOrRejectAccreditation,
    null,
  )

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900">{dto.name}</h1>
          <p className="text-sm text-gray-500">{dto.ownerName ?? dto.ownerEmail} · {dto.ownerEmail}</p>
          <div className="mt-2">
            {dto.isVerified ? (
              <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-green-200 text-green-800">
                Accredited
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-yellow-200 text-yellow-800">
                Pending review
              </span>
            )}
          </div>
        </div>

        {dto.accreditationRejectionReason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm font-medium text-red-800">Previous rejection reason</p>
            <p className="text-sm text-red-700 mt-1">{dto.accreditationRejectionReason}</p>
            {dto.accreditationReviewedAt && (
              <p className="text-xs text-red-500 mt-1">
                Reviewed {new Date(dto.accreditationReviewedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        {dto.documents.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Accreditation Documents</h2>
            <ul className="divide-y divide-gray-100">
              {dto.documents.map((doc) => {
                const db = DOC_STATUS_BADGE[doc.status]
                return (
                  <li key={doc.id} className="py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-gray-800 truncate">{doc.fileName}</p>
                      <p className="text-xs text-gray-500">{doc.documentType}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${db.className}`}
                      >
                        {db.label}
                      </span>
                      <ViewDocumentButton docId={doc.id} fileName={doc.fileName} />
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {!dto.isVerified && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <form action={verifyAction} className="bg-white rounded-lg shadow p-4">
              <input type="hidden" name="labId" value={dto.id} />
              <input type="hidden" name="decision" value="VERIFIED" />
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Verify Accreditation</h3>
              {verifyState && 'message' in verifyState && verifyState.message && (
                <p className="text-sm text-red-600 mb-2">{verifyState.message}</p>
              )}
              <button
                type="submit"
                disabled={verifyPending || rejectPending}
                className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {verifyPending ? 'Verifying…' : 'Verify'}
              </button>
            </form>

            <form action={rejectAction} className="bg-white rounded-lg shadow p-4">
              <input type="hidden" name="labId" value={dto.id} />
              <input type="hidden" name="decision" value="REJECTED" />
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Reject Certificate</h3>
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Reason (required)
                </label>
                <textarea
                  name="reason"
                  required
                  rows={3}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  placeholder="Explain why the certificate is being rejected…"
                />
              </div>
              {rejectState && 'message' in rejectState && rejectState.message && (
                <p className="text-sm text-red-600 mb-2">{rejectState.message}</p>
              )}
              <button
                type="submit"
                disabled={verifyPending || rejectPending}
                className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rejectPending ? 'Rejecting…' : 'Reject'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
