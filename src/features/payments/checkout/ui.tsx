'use client'

/**
 * useActionState drives the form — success path never returns to this component;
 * the server action calls redirect() to Xendit. Error path surfaces action's
 * returned message as a destructive alert, avoiding a separate error page.
 */

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { initiateCheckout } from './action'
import type { CheckoutOrderDTO } from './page'

type PaymentSummaryProps = {
  order: CheckoutOrderDTO
}

/**
 * Accepts pre-serialised DTO (all strings) so no Prisma.Decimal crosses the
 * RSC boundary. The hidden orderId input avoids exposing it in the URL.
 */
export function PaymentSummary({ order }: PaymentSummaryProps) {
  const [state, formAction, isPending] = useActionState(initiateCheckout, null)

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <a href="/dashboard/client" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to dashboard
          </a>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Payment Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Service</span>
                <span className="font-medium">{order.serviceName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Amount</span>
                <span className="text-lg font-semibold text-green-600">₱{order.quotedPrice}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Name</span>
                <span className="font-medium">{order.clientName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Email</span>
                <span className="font-medium">{order.clientEmail}</span>
              </div>
            </div>

            {state?.message && (
              <Alert variant="destructive">
                <AlertDescription>{state.message}</AlertDescription>
              </Alert>
            )}

            <form action={formAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <Button type="submit" className="w-full" disabled={isPending}>
                {isPending ? 'Processing...' : 'Pay Now'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
