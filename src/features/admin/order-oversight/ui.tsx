'use client'

import Link from 'next/link'
import { type OrderStatus } from '@prisma/client'
import type { AdminOrderRowDTO, AdminOrderListProps } from './page'

// satisfies Record<OrderStatus,...> makes a missing enum member a compile-time
// error rather than a runtime wrong-label. (Implementation Discipline — enum dispatch)
const STATUS_BADGE = {
  QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
  QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },
  QUOTE_REJECTED:   { label: 'Quote rejected',   className: 'bg-red-100 text-red-700' },
  PENDING:          { label: 'Pending',           className: 'bg-gray-200 text-gray-700' },
  PAYMENT_PENDING:  { label: 'Payment pending',  className: 'bg-yellow-100 text-yellow-700' },
  PAYMENT_FAILED:   { label: 'Payment failed',   className: 'bg-red-200 text-red-800' },
  ACKNOWLEDGED:     { label: 'Acknowledged',     className: 'bg-indigo-100 text-indigo-700' },
  IN_PROGRESS:      { label: 'In progress',      className: 'bg-purple-100 text-purple-700' },
  COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
  CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
  REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
  REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
} as const satisfies Record<OrderStatus, { label: string; className: string }>

export function AdminOrderListUi({
  rows,
  nextCursor,
  prevCursor,
  showNext,
  showPrev,
}: AdminOrderListProps) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Order Oversight</h1>
          <p className="mt-1 text-sm text-gray-500">
            {rows.length === 0 ? 'No orders found.' : `${rows.length} order${rows.length === 1 ? '' : 's'} shown.`}
          </p>
        </div>

        {rows.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lab</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {rows.map((row: AdminOrderRowDTO) => {
                  const badge = STATUS_BADGE[row.status]
                  return (
                    <tr key={row.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
                        {row.id.slice(0, 12)}&hellip;
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.labName}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.clientDisplayName ?? '—'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.quotedPrice ?? '—'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <Link
                          href={`/dashboard/admin/orders/${row.id}`}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex gap-4">
          {showPrev && prevCursor && (
            <Link
              href={`?cursor=${prevCursor}&dir=prev`}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              &larr; Prev
            </Link>
          )}
          {showNext && nextCursor && (
            <Link
              href={`?cursor=${nextCursor}&dir=next`}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Next &rarr;
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
