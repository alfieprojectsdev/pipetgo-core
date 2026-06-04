'use client'

/**
 * Admin dispute resolution form. Two separate useActionState instances share
 * the same resolveDispute action so each submit button has its own pending/error
 * state. Both error branches are surfaced to rendered text — no silent failures.
 * Dates rendered with fixed locale + timeZone (ref: CLAUDE.md discipline).
 */
import { useActionState } from 'react'
import { resolveDispute } from './action'
import type { DisputeDetailDTO } from './page'

export function DisputeResolutionForm({ dto }: { dto: DisputeDetailDTO }) {
  const [resolveCompletedState, resolveCompletedAction, resolveCompletedPending] =
    useActionState(resolveDispute, null)
  const [resolveRefundState, resolveRefundAction, resolveRefundPending] =
    useActionState(resolveDispute, null)

  const isPending = resolveCompletedPending || resolveRefundPending

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div className="mb-4">
          <a href="/dashboard/admin/disputes" className="text-sm text-blue-600 hover:underline">
            ← Back to disputes
          </a>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Resolve Dispute</h1>

        <div className="bg-white rounded-lg shadow p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500">Order ID</dt>
            <dd className="text-gray-900 font-mono">{dto.id.slice(0, 12)}…</dd>
            <dt className="text-gray-500">Lab</dt>
            <dd className="text-gray-900">{dto.labName}</dd>
            <dt className="text-gray-500">Client</dt>
            <dd className="text-gray-900">{dto.clientEmail}</dd>
            <dt className="text-gray-500">Amount</dt>
            <dd className="text-gray-900">{dto.quotedPrice ?? '—'}</dd>
            <dt className="text-gray-500">Dispute opened</dt>
            <dd className="text-gray-900">
              {new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(dto.disputeOpenedAt))}
            </dd>
          </dl>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Client&apos;s dispute reason</h2>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{dto.disputeReason}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <form action={resolveCompletedAction} className="bg-white rounded-lg shadow p-4">
            <input type="hidden" name="orderId" value={dto.id} />
            <input type="hidden" name="resolution" value="RESOLVED_COMPLETED" />
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Mark as resolved — no refund</h3>
            <p className="text-xs text-gray-500 mb-3">Order returns to COMPLETED; payout hold is lifted.</p>
            <div className="mb-3">
              <label htmlFor="resolutionNoteCompleted" className="block text-xs font-medium text-gray-700 mb-1">
                Resolution note (optional)
              </label>
              <textarea
                id="resolutionNoteCompleted"
                name="resolutionNote"
                rows={3}
                disabled={isPending}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                placeholder="Optional note for the audit record…"
              />
            </div>
            {resolveCompletedState?.message && (
              <p className="text-sm text-red-600 mb-2">{resolveCompletedState.message}</p>
            )}
            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              {resolveCompletedPending ? 'Processing…' : 'Resolve — no refund'}
            </button>
          </form>

          <form action={resolveRefundAction} className="bg-white rounded-lg shadow p-4">
            <input type="hidden" name="orderId" value={dto.id} />
            <input type="hidden" name="resolution" value="RESOLVED_REFUND" />
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Mark as resolved — issue refund</h3>
            <p className="text-xs text-gray-500 mb-3">Order moves to REFUND_PENDING; refund processed separately.</p>
            <div className="mb-3">
              <label htmlFor="resolutionNoteRefund" className="block text-xs font-medium text-gray-700 mb-1">
                Resolution note (optional)
              </label>
              <textarea
                id="resolutionNoteRefund"
                name="resolutionNote"
                rows={3}
                disabled={isPending}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                placeholder="Optional note for the audit record…"
              />
            </div>
            {resolveRefundState?.message && (
              <p className="text-sm text-red-600 mb-2">{resolveRefundState.message}</p>
            )}
            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
            >
              {resolveRefundPending ? 'Processing…' : 'Resolve — issue refund'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
