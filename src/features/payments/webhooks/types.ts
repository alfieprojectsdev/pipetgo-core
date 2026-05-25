/**
 * Xendit-specific webhook types.
 *
 * XenditInvoicePayload is the raw shape of the Xendit invoice callback body.
 * route.ts parses and casts to this type, then normalizes to NormalizedWebhookPayload
 * before dispatching to handlers. handlers.ts never imports this type.
 */
import type { NormalizedWebhookPayload } from '@/lib/payments/types'

export interface XenditInvoicePayload {
  id: string
  status: string
  paid_amount: number
  payer_email: string
  payment_method?: string
}

/**
 * Xendit-specific adapter. Co-locates with XenditInvoicePayload because per-provider
 * adapters belong with their provider type, not in lib/payments/. (ref: DL-010)
 *
 * Throws when payload.id is null, empty, or non-string so malformed payloads are
 * rejected at the route boundary with a 400 rather than propagating as a 500. (ref: DL-015)
 */
export function normalizeXenditInvoicePayload(raw: XenditInvoicePayload): NormalizedWebhookPayload {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    throw new Error('Xendit payload missing required id field')
  }
  return {
    externalId: raw.id,
    paymentMethod: raw.payment_method,
  }
}
