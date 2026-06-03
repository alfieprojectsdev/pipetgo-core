'use client'

import { type OrderStatus, type TransactionStatus, type PayoutStatus } from '@prisma/client'
import type { AdminOrderDetailDTO } from './detail-page'
import { AttachmentListUi } from './attachment-list-ui'

// satisfies Record<EnumType,...> on all three badge tables makes a missing enum
// member a compile-time error rather than a runtime wrong-label.
// (Implementation Discipline — enum dispatch)
const ORDER_STATUS_BADGE = {
  QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
  QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },
  QUOTE_REJECTED:   { label: 'Quote rejected',   className: 'bg-red-100 text-red-700' },
  PENDING:          { label: 'Pending',           className: 'bg-gray-200 text-gray-700' },
  PAYMENT_PENDING:  { label: 'Payment pending',  className: 'bg-yellow-100 text-yellow-700' },
  PAYMENT_FAILED:   { label: 'Payment failed',   className: 'bg-red-200 text-red-800' },
  ACKNOWLEDGED:     { label: 'Acknowledged',     className: 'bg-indigo-100 text-indigo-700' },
  IN_PROGRESS:      { label: 'In progress',      className: 'bg-purple-100 text-purple-700' },
  COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
  // amber-200: visual distinction from adjacent COMPLETED (green-200) and REFUND_PENDING (orange-100) (ref: DL-008).
  DISPUTED:         { label: 'Disputed',         className: 'bg-amber-200 text-amber-800' },
  CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
  REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
  REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
} as const satisfies Record<OrderStatus, { label: string; className: string }>

const TRANSACTION_STATUS_BADGE = {
  PENDING:    { label: 'Pending',    className: 'bg-gray-100 text-gray-600' },
  PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-700' },
  CAPTURED:   { label: 'Captured',   className: 'bg-green-100 text-green-700' },
  FAILED:     { label: 'Failed',     className: 'bg-red-100 text-red-700' },
  REFUNDED:   { label: 'Refunded',   className: 'bg-orange-100 text-orange-700' },
} as const satisfies Record<TransactionStatus, { label: string; className: string }>

const PAYOUT_STATUS_BADGE = {
  QUEUED:     { label: 'Queued',     className: 'bg-gray-100 text-gray-600' },
  PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-700' },
  COMPLETED:  { label: 'Completed',  className: 'bg-green-100 text-green-700' },
  FAILED:     { label: 'Failed',     className: 'bg-red-100 text-red-700' },
} as const satisfies Record<PayoutStatus, { label: string; className: string }>

export function AdminOrderDetailUi({ dto }: { dto: AdminOrderDetailDTO }) {
  const orderBadge = ORDER_STATUS_BADGE[dto.status]

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Order {dto.id}</h1>
          <div className="mt-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${orderBadge.className}`}>
              {orderBadge.label}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500">Lab</dt>
            <dd className="text-gray-900">{dto.lab.name}</dd>
            <dt className="text-gray-500">Service</dt>
            <dd className="text-gray-900">{dto.service.name}</dd>
            <dt className="text-gray-500">Quoted price</dt>
            <dd className="text-gray-900">{dto.quotedPrice ?? '—'}</dd>
            <dt className="text-gray-500">Quoted at</dt>
            <dd className="text-gray-900">{dto.quotedAt ? new Date(dto.quotedAt).toLocaleString() : '—'}</dd>
            <dt className="text-gray-500">Paid at</dt>
            <dd className="text-gray-900">{dto.paidAt ? new Date(dto.paidAt).toLocaleString() : '—'}</dd>
            <dt className="text-gray-500">Refunded at</dt>
            <dd className="text-gray-900">{dto.refundedAt ? new Date(dto.refundedAt).toLocaleString() : '—'}</dd>
            <dt className="text-gray-500">Created</dt>
            <dd className="text-gray-900">{new Date(dto.createdAt).toLocaleString()}</dd>
            <dt className="text-gray-500">Updated</dt>
            <dd className="text-gray-900">{new Date(dto.updatedAt).toLocaleString()}</dd>
          </dl>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Client</h2>
          {dto.clientProfile ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-500">Name</dt>
              <dd className="text-gray-900">{dto.clientProfile.name}</dd>
              <dt className="text-gray-500">Email</dt>
              <dd className="text-gray-900">{dto.clientProfile.email}</dd>
              <dt className="text-gray-500">Phone</dt>
              <dd className="text-gray-900">{dto.clientProfile.phone}</dd>
              {dto.clientProfile.organization && (
                <>
                  <dt className="text-gray-500">Organization</dt>
                  <dd className="text-gray-900">{dto.clientProfile.organization}</dd>
                </>
              )}
              {dto.clientProfile.address && (
                <>
                  <dt className="text-gray-500">Address</dt>
                  <dd className="text-gray-900">{dto.clientProfile.address}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-gray-500">
              {dto.client.name ?? dto.client.email} ({dto.client.email}) — no profile snapshot
            </p>
          )}
        </div>

        {dto.transactions.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h2 className="text-sm font-semibold text-gray-700">Transactions</h2>
            </div>
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Captured</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {dto.transactions.map((t) => {
                  const tb = TRANSACTION_STATUS_BADGE[t.status]
                  return (
                    <tr key={t.id}>
                      <td className="px-4 py-2 text-sm text-gray-900">{t.amount}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tb.className}`}>
                          {tb.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500">{t.paymentMethod ?? '—'}</td>
                      <td className="px-4 py-2 text-sm text-gray-500">
                        {t.capturedAt ? new Date(t.capturedAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {dto.payouts.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-4 py-3 border-b">
              <h2 className="text-sm font-semibold text-gray-700">Payouts</h2>
            </div>
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gross</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Fee</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Net</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scheduled</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {dto.payouts.map((p) => {
                  const pb = PAYOUT_STATUS_BADGE[p.status]
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-2 text-sm text-gray-900">{p.grossAmount}</td>
                      <td className="px-4 py-2 text-sm text-gray-500">{p.platformFee}</td>
                      <td className="px-4 py-2 text-sm text-gray-900">{p.netAmount}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${pb.className}`}>
                          {pb.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500">
                        {p.scheduledDate ? new Date(p.scheduledDate).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500">
                        {p.completedAt ? new Date(p.completedAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <AttachmentListUi attachments={dto.attachments} />
      </div>
    </div>
  )
}
