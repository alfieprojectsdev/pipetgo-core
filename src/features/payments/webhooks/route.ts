/**
 * Xendit invoice webhook POST handler.
 *
 * Authenticates via x-callback-token header (static token, not HMAC).
 * Non-PAID payloads return 200 immediately — Xendit expects acknowledgement for
 * all delivery attempts regardless of business relevance. (ref: DL-002, DL-006)
 *
 * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
 * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { processPaymentCapture } from './handlers'
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

  // Acknowledge non-PAID events without processing — Xendit sends PENDING, EXPIRED etc. (ref: DL-006)
  if (payload.status !== 'PAID') {
    return NextResponse.json({ received: true })
  }

  await processPaymentCapture(payload)

  return NextResponse.json({ received: true })
}
