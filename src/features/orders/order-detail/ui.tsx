'use client'

import { useActionState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { acceptQuote, rejectQuote, retryPayment } from './action'

export function OrderDetailQuoteActions({
  orderId,
  quotedPrice,
}: {
  orderId: string
  quotedPrice: string
}) {
  const [acceptState, acceptAction] = useActionState(acceptQuote, null)
  const [rejectState, rejectAction] = useActionState(rejectQuote, null)

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <p className="text-sm text-gray-700 mb-4">
          You have a quote of <span className="font-semibold">₱{quotedPrice}</span>.
          Accept to proceed to payment, or reject to decline.
        </p>
        <div className="flex gap-3">
          <form action={acceptAction}>
            <input type="hidden" name="orderId" value={orderId} />
            <Button type="submit">Accept Quote</Button>
          </form>
          <form action={rejectAction}>
            <input type="hidden" name="orderId" value={orderId} />
            <Button type="submit" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50">
              Reject Quote
            </Button>
          </form>
        </div>
        {acceptState?.message && (
          <p className="mt-2 text-sm text-red-600">{acceptState.message}</p>
        )}
        {rejectState?.message && (
          <p className="mt-2 text-sm text-red-600">{rejectState.message}</p>
        )}
      </CardContent>
    </Card>
  )
}

// OrderDetailRetryPayment: single-action card rendered only when status === PAYMENT_FAILED.
// Does not re-display quotedPrice — user already accepted quote before reaching this state.
export function OrderDetailRetryPayment({
  orderId,
}: {
  orderId: string
}) {
  const [state, retryAction] = useActionState(retryPayment, null)

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <p className="text-sm text-gray-700 mb-4">
          Your previous payment attempt expired. Click Retry Payment to start a new payment.
        </p>
        <form action={retryAction}>
          <input type="hidden" name="orderId" value={orderId} />
          <Button type="submit">Retry Payment</Button>
        </form>
        {state?.message && (
          <p className="mt-2 text-sm text-red-600">{state.message}</p>
        )}
      </CardContent>
    </Card>
  )
}
