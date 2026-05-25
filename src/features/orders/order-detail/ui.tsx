'use client'

import { useActionState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { acceptQuote, rejectQuote, retryPayment } from './action'
import { initiateVaCheckout } from '@/features/payments/checkout/action'
import { PESONET_BANK_CODES, PESONET_BANK_LABELS, type PesonetBankCode } from '@/domain/payments/pesonet'

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

/** Displays VA instructions after bank transfer setup — rendered when vaNumber is set. */
export function OrderDetailVaInstructions({
  bankCode,
  vaNumber,
  quotedPrice,
}: {
  bankCode: string | null
  vaNumber: string
  quotedPrice: string
}) {
  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <p className="text-sm font-semibold text-gray-900 mb-3">PESONet Bank Transfer Instructions</p>
        <dl className="divide-y divide-gray-100 text-sm">
          {bankCode && (
            <div className="flex justify-between py-2">
              <dt className="text-gray-500">Bank</dt>
              <dd className="text-gray-900 font-medium">
                {PESONET_BANK_LABELS[bankCode as PesonetBankCode] ?? bankCode}
              </dd>
            </div>
          )}
          <div className="flex justify-between py-2">
            <dt className="text-gray-500">Account Number</dt>
            <dd className="text-gray-900 font-mono font-semibold">{vaNumber}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-gray-500">Amount</dt>
            <dd className="text-gray-900 font-semibold">₱{quotedPrice}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-gray-500">
          Transfer the exact amount above. The virtual account expires in 72 hours.
        </p>
      </CardContent>
    </Card>
  )
}

/** Bank code selector for initiating PESONet VA — rendered when PAYMENT_PENDING and no VA exists. */
export function OrderDetailVaBankSelector({ orderId }: { orderId: string }) {
  const [state, formAction] = useActionState(initiateVaCheckout, null)

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <p className="text-sm text-gray-700 mb-4">
          Pay via PESONet bank transfer. Select your bank to receive a virtual account number.
        </p>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="orderId" value={orderId} />
          <select
            name="bankCode"
            required
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select bank…</option>
            {PESONET_BANK_CODES.map((code) => (
              <option key={code} value={code}>
                {PESONET_BANK_LABELS[code]}
              </option>
            ))}
          </select>
          <Button type="submit">Set Up Bank Transfer</Button>
        </form>
        {state?.message && (
          <p className="mt-2 text-sm text-red-600">{state.message}</p>
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
