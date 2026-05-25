/**
 * Xendit FVA payment webhook POST handler.
 *
 * Normalization boundary: verifies auth, parses XenditVaPayload, normalizes to
 * NormalizedWebhookPayload with idempotencyKeyPrefix='xendit:va', dispatches to
 * handlers. handlers.ts never imports XenditVaPayload.
 *
 * Status dispatch:
 *   COMPLETED -> processPaymentCapture
 *   EXPIRED, FAILED -> processPaymentFailed
 *   PENDING, ACTIVE, unknown -> 200 no-op (prevents Xendit retry storms)
 *
 * Auth: reuses verifyXenditToken — Xendit uses the same x-callback-token mechanism
 * for FVA callbacks as for invoice callbacks.
 */
import { NextRequest, NextResponse } from 'next/server'
import { processPaymentCapture, processPaymentFailed } from '../handlers'
import { type XenditVaPayload, normalizeXenditVaPayload } from './types'
import { verifyXenditToken } from '@/lib/payments/webhook-auth'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.XENDIT_WEBHOOK_TOKEN
  if (!secret) {
    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
  }

  if (!verifyXenditToken(req, secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  let payload: XenditVaPayload
  let normalized
  try {
    const parsed = (await req.json()) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json({ error: 'Malformed Xendit VA payload.' }, { status: 400 })
    }
    payload = parsed as XenditVaPayload
    normalized = normalizeXenditVaPayload(payload)
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  const status = (payload.status ?? '').toUpperCase()
  console.info(`[va-webhook] callback_virtual_account_id=${payload.callback_virtual_account_id} status=${status}`)

  try {
    switch (status) {
      case 'COMPLETED':
        await processPaymentCapture(normalized)
        break
      case 'EXPIRED':
      case 'FAILED':
        await processPaymentFailed(normalized)
        break
      default:
        console.info(`[va-webhook] no-op status=${status}`)
    }
  } catch (err) {
    console.error('[va-webhook] handler error', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
