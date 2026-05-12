/**
 * Xendit invoice webhook POST handler.
 *
 * Authenticates via x-callback-token header (static token, not HMAC).
 * PAID dispatches to processPaymentCapture; EXPIRED to processPaymentFailed.
 * Unknown statuses are acknowledged without processing; missing status throws. (ref: DL-009)
 *
 * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
 * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { processPaymentCapture, processPaymentFailed } from './handlers'
import type { XenditInvoicePayload } from './types'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.XENDIT_WEBHOOK_TOKEN
  if (!expected) {
    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
  }

  const token = req.headers.get('x-callback-token') ?? ''
  const tokenBuf = Buffer.from(token)
  const expectedBuf = Buffer.from(expected)
  // Buffer length check required before timingSafeEqual — equal-length is a precondition.
  // timingSafeEqual prevents timing attacks on constant-time comparison. (ref: DL-002)
  const tokensMatch =
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf)

  if (!tokensMatch) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const payload = (await req.json()) as XenditInvoicePayload

  const status = (payload.status ?? '').toUpperCase()
  console.info(`[webhook] received payload id=${payload.id} status=${status}`)

  if (status === '') {
    throw new Error('Xendit webhook missing payload.status')
  }

  switch (status) {
    case 'PAID':
      console.info(`[webhook] dispatch to processPaymentCapture id=${payload.id}`)
      await processPaymentCapture(payload)
      break
    case 'EXPIRED':
      console.info(`[webhook] dispatch to processPaymentFailed id=${payload.id}`)
      await processPaymentFailed(payload)
      break
    default:
      console.info(`[webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
  }

  return NextResponse.json({ received: true })
}
