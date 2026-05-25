/**
 * Xendit invoice webhook POST handler.
 *
 * route.ts is the normalization boundary: it verifies provider auth, parses the raw
 * XenditInvoicePayload, normalizes to NormalizedWebhookPayload, then dispatches to
 * handlers. Handlers receive only NormalizedWebhookPayload — no Xendit-specific types
 * cross the route/handler boundary. (ref: DL-001)
 *
 * verifyXenditToken preserves the buffer-length precondition inside its implementation
 * so callers need only pass (req, secret). (ref: DL-008)
 *
 * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
 * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
 */
import { NextRequest, NextResponse } from 'next/server'
import { processPaymentCapture, processPaymentFailed } from './handlers'
import { type XenditInvoicePayload, normalizeXenditInvoicePayload } from './types'
import { verifyXenditToken } from '@/lib/payments/webhook-auth'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.XENDIT_WEBHOOK_TOKEN
  if (!secret) {
    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
  }

  if (!verifyXenditToken(req, secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  let payload: XenditInvoicePayload
  let normalized
  try {
    const parsed = (await req.json()) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json({ error: 'Malformed Xendit payload.' }, { status: 400 })
    }
    payload = parsed as XenditInvoicePayload
    normalized = normalizeXenditInvoicePayload(payload)
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  const status = (payload.status ?? '').toUpperCase()
  console.info(`[webhook] received payload id=${payload.id} status=${status}`)

  if (status === '') {
    throw new Error('Xendit webhook missing payload.status')
  }

  switch (status) {
    case 'PAID':
      console.info(`[webhook] dispatch to processPaymentCapture id=${payload.id}`)
      await processPaymentCapture(normalized)
      break
    case 'EXPIRED':
      console.info(`[webhook] dispatch to processPaymentFailed id=${payload.id}`)
      await processPaymentFailed(normalized)
      break
    default:
      console.info(`[webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
  }

  return NextResponse.json({ received: true })
}
