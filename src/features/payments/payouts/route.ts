/**
 * Xendit sub-account settlement webhook POST handler.
 *
 * Authenticates via x-callback-token header (static token, not HMAC).
 * COMPLETED dispatches to processSettlement; unknown statuses are acknowledged without processing.
 * Missing or empty status throws so Xendit retries.
 *
 * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
 * No auth() call — webhook is server-to-server; token header is the only credential.
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { processSettlement } from './handlers'
import type { XenditSettlementPayload } from './types'

// TODO(sandbox-verify): confirm Xendit settlement status string is COMPLETED.
// Could be SUCCEEDED or another variant — payload status is unverified (ref: DL-010, R-002).
// The constant is named rather than inlined so it is visible at code level; see AC-006 pre-merge gate.
const SETTLEMENT_STATUS_COMPLETED = 'COMPLETED'

// Auth uses static x-callback-token (crypto.timingSafeEqual) not HMAC-SHA256 —
// Xendit does not provide HMAC for settlement callbacks (ref: DL-006).
// XENDIT_SETTLEMENT_WEBHOOK_TOKEN is a separate env var from XENDIT_WEBHOOK_TOKEN
// so each webhook endpoint can rotate its token independently. (ref: DL-006)

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.XENDIT_SETTLEMENT_WEBHOOK_TOKEN
  if (!expected) {
    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
  }

  const token = req.headers.get('x-callback-token') ?? ''
  const tokenBuf = Buffer.from(token)
  const expectedBuf = Buffer.from(expected)
  // Buffer length check required before timingSafeEqual — equal-length is a precondition.
  // timingSafeEqual prevents timing attacks on constant-time comparison.
  const tokensMatch =
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf)

  if (!tokensMatch) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const payload = (await req.json()) as XenditSettlementPayload

  const status = (payload.status ?? '').toUpperCase()
  console.info(`[settlement-webhook] received payload id=${payload.id} status=${status}`)

  if (status === '') {
    throw new Error('Xendit settlement webhook missing payload.status')
  }

  if (status === SETTLEMENT_STATUS_COMPLETED) {
    console.info(`[settlement-webhook] dispatch to processSettlement id=${payload.id}`)
    await processSettlement(payload)
  } else {
    console.info(`[settlement-webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
  }

  return NextResponse.json({ received: true })
}
