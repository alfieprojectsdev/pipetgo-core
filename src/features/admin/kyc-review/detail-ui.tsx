'use client'

import { useActionState, useTransition } from 'react'
import { type KycStatus, type DocumentStatus } from '@prisma/client'
import { approveOrRejectKyc } from './action'
import { viewKycDocument } from './view-document-action'
import type { LabKycDetailDTO } from './detail-page'

const KYC_STATUS_BADGE = {
  PENDING:   { label: 'Not started',    className: 'bg-gray-200 text-gray-700' },
  SUBMITTED: { label: 'Pending review', className: 'bg-yellow-200 text-yellow-800' },
  APPROVED:  { label: 'Verified',       className: 'bg-green-200 text-green-800' },
  REJECTED:  { label: 'Rejected',       className: 'bg-red-200 text-red-700' },
} as const satisfies Record<KycStatus, { label: string; className: string }>

const DOC_STATUS_BADGE = {
  PENDING:  { label: 'Pending upload', className: 'bg-gray-100 text-gray-600' },
  UPLOADED: { label: 'Uploaded',       className: 'bg-blue-100 text-blue-700' },
  VERIFIED: { label: 'Verified',       className: 'bg-green-100 text-green-700' },
  REJECTED: { label: 'Rejected',       className: 'bg-red-100 text-red-700' },
} as const satisfies Record<DocumentStatus, { label: string; className: string }>

/**
 * Mints a presigned GET URL on click via viewKycDocument and opens it in a new tab.
 * URL is not pre-fetched or stored in component state — each click triggers a fresh
 * Server Action call that re-checks ADMIN role and binds a new 300s TTL. (ref: DL-004)
 */
function ViewDocumentButton({ docId, fileName }: { docId: string; fileName: string }) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      const result = await viewKycDocument(docId)
      if ('url' in result) {
        window.open(result.url, '_blank', 'noopener,noreferrer')
      }
    })
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="text-blue-600 hover:text-blue-800 text-sm font-medium disabled:opacity-50"
    >
      {isPending ? 'Loading…' : `View ${fileName}`}
    </button>
  )
}

export function AdminKycDetailUi({ dto }: { dto: LabKycDetailDTO }) {
  const kycBadge = KYC_STATUS_BADGE[dto.kycStatus]

  const [approveState, approveAction, approvePending] = useActionState(
    approveOrRejectKyc,
    null,
  )
  const [rejectState, rejectAction, rejectPending] = useActionState(
    approveOrRejectKyc,
    null,
  )

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900">{dto.name}</h1>
          <p className="text-sm text-gray-500">{dto.ownerName ?? dto.ownerEmail} · {dto.ownerEmail}</p>
          <div className="mt-2">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${kycBadge.className}`}
            >
              {kycBadge.label}
            </span>
          </div>
        </div>

        {dto.kycRejectionReason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm font-medium text-red-800">Previous rejection reason</p>
            <p className="text-sm text-red-700 mt-1">{dto.kycRejectionReason}</p>
            {dto.kycReviewedAt && (
              <p className="text-xs text-red-500 mt-1">
                Reviewed {new Date(dto.kycReviewedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        {dto.documents.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Documents</h2>
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

        {dto.kycStatus === 'SUBMITTED' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <form action={approveAction} className="bg-white rounded-lg shadow p-4">
              <input type="hidden" name="labId" value={dto.id} />
              <input type="hidden" name="decision" value="APPROVED" />
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Approve KYC</h3>
              {approveState && 'message' in approveState && approveState.message && (
                <p className="text-sm text-red-600 mb-2">{approveState.message}</p>
              )}
              <button
                type="submit"
                disabled={approvePending || rejectPending}
                className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {approvePending ? 'Approving…' : 'Approve'}
              </button>
            </form>

            <form action={rejectAction} className="bg-white rounded-lg shadow p-4">
              <input type="hidden" name="labId" value={dto.id} />
              <input type="hidden" name="decision" value="REJECTED" />
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Reject KYC</h3>
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Reason (required)
                </label>
                <textarea
                  name="reason"
                  required
                  rows={3}
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  placeholder="Explain why the submission is being rejected…"
                />
              </div>
              {rejectState && 'message' in rejectState && rejectState.message && (
                <p className="text-sm text-red-600 mb-2">{rejectState.message}</p>
              )}
              <button
                type="submit"
                disabled={approvePending || rejectPending}
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
