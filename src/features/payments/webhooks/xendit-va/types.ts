/**
 * Xendit FVA payment webhook types.
 *
 * XenditVaPayload is the raw shape of the Xendit FVA payment callback body.
 * xendit-va/route.ts normalizes to NormalizedWebhookPayload before dispatching.
 * handlers.ts never imports this type.
 */
import type { NormalizedWebhookPayload } from '@/lib/payments/types'

export interface XenditVaPayload {
  callback_virtual_account_id: string
  external_id: string
  bank_code?: string
  status: string
  amount?: number
}

const VA_FAILURE_REASON: Record<string, string> = {
  EXPIRED: 'Xendit VA EXPIRED',
  FAILED: 'Xendit VA FAILED',
}

export function normalizeXenditVaPayload(raw: XenditVaPayload): NormalizedWebhookPayload {
  if (typeof raw.callback_virtual_account_id !== 'string' || raw.callback_virtual_account_id.trim() === '') {
    throw new Error('Xendit VA payload missing required callback_virtual_account_id field')
  }
  const status = (raw.status ?? '').toUpperCase()
  return {
    externalId: raw.callback_virtual_account_id,
    paymentMethod: raw.bank_code,
    idempotencyKeyPrefix: 'xendit:va',
    failureReason: VA_FAILURE_REASON[status],
  }
}
