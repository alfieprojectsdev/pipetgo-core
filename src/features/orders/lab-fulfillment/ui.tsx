'use client'

/**
 * Client component for the lab fulfillment page.
 *
 * Renders order details and two forms:
 *   - Start Processing (ACKNOWLEDGED -> IN_PROGRESS)
 *   - Complete Order   (IN_PROGRESS  -> COMPLETED) with a notes text field
 *
 * Each form uses useActionState with its own server action. Only the
 * relevant form is shown based on the current order status.
 */

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { startProcessing, completeOrder } from './action'
import type { LabOrderDTO } from './page'

type LabFulfillmentUIProps = {
  order: LabOrderDTO
}

/**
 * Form for the ACKNOWLEDGED -> IN_PROGRESS transition. Submits orderId as a
 * hidden field; displays the server action error message on failure.
 */
function StartProcessingForm({ orderId }: { orderId: string }) {
  const [state, formAction, isPending] = useActionState(startProcessing, null)

  return (
    <div className="space-y-3">
      {state?.message && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <form action={formAction}>
        <input type="hidden" name="orderId" value={orderId} />
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? 'Starting...' : 'Start Processing'}
        </Button>
      </form>
    </div>
  )
}

/**
 * Form for the IN_PROGRESS -> COMPLETED transition. Includes a plain HTML
 * textarea for result notes (no shadcn Textarea component exists). Notes are
 * optional; the server action treats an empty value as null. (ref: DL-003)
 */
function CompleteOrderForm({ orderId }: { orderId: string }) {
  const [state, formAction, isPending] = useActionState(completeOrder, null)

  return (
    <div className="space-y-3">
      {state?.message && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="orderId" value={orderId} />
        <div className="space-y-1">
          <label htmlFor="notes" className="text-sm font-medium text-gray-700">
            Results / Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter results or notes for this order..."
          />
        </div>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? 'Completing...' : 'Complete Order'}
        </Button>
      </form>
    </div>
  )
}

export function LabFulfillmentUI({ order }: LabFulfillmentUIProps) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <a href="/dashboard/lab" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to dashboard
          </a>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Order Fulfillment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Service</span>
                <span className="font-medium">{order.serviceName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Amount</span>
                <span className="font-medium">₱{order.quotedPrice}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Client</span>
                <span className="font-medium">{order.clientName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Status</span>
                <span className="font-medium">{order.status}</span>
              </div>
              {order.notes && (
                <div className="pt-2">
                  <span className="text-sm text-gray-600">Order Notes</span>
                  <p className="text-sm mt-1">{order.notes}</p>
                </div>
              )}
            </div>

            {order.status === 'ACKNOWLEDGED' && (
              <StartProcessingForm orderId={order.id} />
            )}
            {order.status === 'IN_PROGRESS' && (
              <CompleteOrderForm orderId={order.id} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
