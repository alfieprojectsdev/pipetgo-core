'use client'

import { useActionState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { provideQuote, cancelOrder } from './action'
import type { QuoteOrderDTO } from './page'

export function QuoteProvideUI({
  orderId,
  order,
}: {
  orderId: string
  order: QuoteOrderDTO
}) {
  const [provideState, provideAction] = useActionState(provideQuote, null)
  const [cancelState, cancelAction] = useActionState(cancelOrder, null)

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-4">
          <a href="/dashboard/lab" className="text-sm text-blue-600 hover:underline">
            ← Back to dashboard
          </a>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Provide Quote —{' '}
            <span className="font-mono text-lg">{orderId.slice(0, 8)}…</span>
          </h1>
        </div>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-gray-100 text-sm">
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Service</dt>
                <dd className="text-gray-900">{order.serviceName}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Client</dt>
                <dd className="text-gray-900">{order.clientName ?? 'Unknown Client'}</dd>
              </div>
              {order.clientEmail != null && (
                <div className="flex justify-between py-2">
                  <dt className="text-gray-500">Email</dt>
                  <dd className="text-gray-900">{order.clientEmail}</dd>
                </div>
              )}
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Quantity</dt>
                <dd className="text-gray-900">{order.quantity}</dd>
              </div>
              {order.notes != null && (
                <div className="flex justify-between py-2">
                  <dt className="text-gray-500">Notes</dt>
                  <dd className="text-gray-900 max-w-xs text-right">{order.notes}</dd>
                </div>
              )}
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Submitted</dt>
                <dd className="text-gray-900">
                  {new Date(order.createdAt).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Provide Quote</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={provideAction} className="flex flex-col gap-4">
              <input type="hidden" name="orderId" value={orderId} />
              <div className="flex flex-col gap-1">
                <label htmlFor="price" className="text-sm font-medium text-gray-700">
                  Price (₱)
                </label>
                <input
                  id="price"
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="0.00"
                />
              </div>
              {provideState?.message && (
                <p className="text-sm text-red-600">{provideState.message}</p>
              )}
              <Button type="submit">Provide Quote</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cancel Order</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={cancelAction}>
              <input type="hidden" name="orderId" value={orderId} />
              {cancelState?.message && (
                <p className="mb-2 text-sm text-red-600">{cancelState.message}</p>
              )}
              <Button type="submit" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50">
                Cancel Order
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
