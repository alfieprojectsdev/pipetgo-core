'use client'

/**
 * Client component for the client dashboard order listing.
 *
 * Renders a flat table of all orders for the authenticated client, newest-first.
 * No tabs or status filtering — clients view full order history chronologically. (ref: DL-002)
 */

import { OrderStatus } from '@prisma/client'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import type { ClientDashboardOrderDTO } from './page'

/**
 * Exhaustive map covering all 12 OrderStatus enum values.
 *
 * Typed as Record<OrderStatus, ...> (not Record<string, ...>) so TypeScript
 * enforces that every enum member is present — a missing entry is a compile
 * error caught by `tsc --noEmit` before deploy. A `??` fallback in the render
 * loop guards against unknown values at runtime (e.g. future enum additions
 * before a deploy). (ref: DL-003)
 *
 * No shared Badge component exists in V2; inline span with Tailwind classes
 * is sufficient for this single consumer. (ref: DL-004)
 */
const statusBadgeConfig: Record<OrderStatus, { label: string; className: string }> = {
  [OrderStatus.QUOTE_REQUESTED]: { label: 'Quote Requested', className: 'bg-gray-100 text-gray-700' },
  [OrderStatus.QUOTE_PROVIDED]: { label: 'Quote Provided', className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.QUOTE_REJECTED]: { label: 'Quote Rejected', className: 'bg-red-100 text-red-800' },
  [OrderStatus.PENDING]: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending', className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.PAYMENT_FAILED]: { label: 'Payment Failed', className: 'bg-red-100 text-red-800' },
  [OrderStatus.ACKNOWLEDGED]: { label: 'Acknowledged', className: 'bg-blue-100 text-blue-800' },
  [OrderStatus.IN_PROGRESS]: { label: 'In Progress', className: 'bg-blue-100 text-blue-800' },
  [OrderStatus.COMPLETED]: { label: 'Completed', className: 'bg-green-100 text-green-800' },
  [OrderStatus.CANCELLED]: { label: 'Cancelled', className: 'bg-red-100 text-red-800' },
  [OrderStatus.REFUND_PENDING]: { label: 'Refund Pending', className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.REFUNDED]: { label: 'Refunded', className: 'bg-gray-100 text-gray-700' },
}

type ClientDashboardUIProps = {
  orders: ClientDashboardOrderDTO[]
}

export function ClientDashboardUI({ orders }: ClientDashboardUIProps) {
  if (orders.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Client Dashboard</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Your Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500 py-4 text-center">You have no orders yet.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Client Dashboard</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Your Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="pb-2 pr-4 font-medium">Order ID</th>
                  <th className="pb-2 pr-4 font-medium">Service Name</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const badge = statusBadgeConfig[order.status as OrderStatus] ?? { label: order.status, className: 'bg-gray-100 text-gray-500' }
                  return (
                    <tr key={order.id} className="border-b last:border-0">
                      <td className="py-3 pr-4">
                        <a
                          href={`/dashboard/orders/${order.id}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {order.id.slice(0, 8)}…
                        </a>
                      </td>
                      <td className="py-3 pr-4">{order.serviceName}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-3">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
