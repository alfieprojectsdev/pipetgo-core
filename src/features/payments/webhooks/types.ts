/**
 * Shape of the Xendit invoice webhook payload.
 * Shared by route.ts (parse + cast) and handlers.ts (process).
 * Defined once here to prevent silent type divergence between the two files.
 */
export interface XenditInvoicePayload {
  id: string
  status: string
  paid_amount: number
  payer_email: string
  payment_method?: string
}
