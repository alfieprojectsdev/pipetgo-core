'use client'

/**
 * Client component for the lab dashboard.
 *
 * Renders three tabs — Incoming (ACKNOWLEDGED), Active (IN_PROGRESS),
 * History (COMPLETED or CANCELLED) — with client-side useState switching.
 * Incoming and Active tabs display orders oldest-first (FIFO).
 * History tab displays orders newest-first via toReversed().
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import type { LabDashboardOrderDTO } from './page'

type Tab = 'Quoting' | 'Incoming' | 'Active' | 'History'

type LabDashboardUIProps = {
  orders: LabDashboardOrderDTO[]
}

function OrderTable({ orders }: { orders: LabDashboardOrderDTO[] }) {
  if (orders.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-4 text-center">No orders to display.</p>
    )
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-600">
          <th className="pb-2 pr-4 font-medium">Order ID</th>
          <th className="pb-2 pr-4 font-medium">Service Name</th>
          <th className="pb-2 pr-4 font-medium">Client Name</th>
          <th className="pb-2 font-medium">Date</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id} className="border-b last:border-0">
            <td className="py-3 pr-4">
              <a
                href={`/dashboard/lab/orders/${order.id}`}
                className="font-mono text-xs text-blue-600 hover:underline"
              >
                {order.id.slice(0, 8)}…
              </a>
            </td>
            <td className="py-3 pr-4">{order.serviceName}</td>
            <td className="py-3 pr-4">{order.clientName}</td>
            <td className="py-3">
              {new Date(order.createdAt).toLocaleDateString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Receives all lab orders in a single array and partitions them client-side
 * into the three tabs. A single RSC fetch avoids three separate round-trips
 * and keeps the auth + ownership guard logic in one place. (ref: DL-001)
 *
 * Tab state is managed with useState; no URL query param is used because
 * direct-linking to a specific tab is not required. (ref: DL-002)
 */
export function LabDashboardUI({ orders }: LabDashboardUIProps) {
  const [activeTab, setActiveTab] = useState<Tab>('Incoming')

  const quoting = orders.filter((o) => o.status === 'QUOTE_REQUESTED')
  const incoming = orders.filter((o) => o.status === 'ACKNOWLEDGED')
  const active = orders.filter((o) => o.status === 'IN_PROGRESS')
  // History is newest-first so lab admins see the most recent completions
  // at the top. The Prisma query returns all orders oldest-first (asc) to
  // satisfy FIFO for Incoming/Active; History reverses client-side. (ref: DL-003)
  const history = orders
    .filter((o) => o.status === 'COMPLETED' || o.status === 'CANCELLED' || o.status === 'QUOTE_REJECTED')
    .toReversed()

  const tabs: { label: Tab; count: number }[] = [
    { label: 'Quoting',  count: quoting.length },
    { label: 'Incoming', count: incoming.length },
    { label: 'Active',   count: active.length },
    { label: 'History',  count: history.length },
  ]

  const currentOrders =
    activeTab === 'Quoting'  ? quoting  :
    activeTab === 'Incoming' ? incoming :
    activeTab === 'Active'   ? active   : history

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Lab Dashboard</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-6">
              {tabs.map(({ label, count }) => (
                <Button
                  key={label}
                  variant={activeTab === label ? 'default' : 'outline'}
                  onClick={() => setActiveTab(label)}
                >
                  {label}
                  <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                    {count}
                  </span>
                </Button>
              ))}
            </div>

            <OrderTable orders={currentOrders} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
