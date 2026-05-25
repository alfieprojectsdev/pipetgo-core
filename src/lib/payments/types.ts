/**
 * Shared payment types — provider-agnostic interfaces consumed by feature slices.
 *
 * Route handlers normalize provider-specific payloads into these types before
 * dispatching to handlers. Handlers depend only on these types, not on any
 * provider SDK shape. (ref: T-14 normalization boundary)
 *
 * Must not import from @/features/ or @/domain/; this is infrastructure.
 */

/**
 * Normalized shape passed from a webhook route handler to processPaymentCapture
 * and processPaymentFailed. Contains only the fields the handlers need; raw
 * provider fields (status, paid_amount, payer_email) are consumed in route.ts.
 */
export interface NormalizedWebhookPayload {
  externalId: string
  paymentMethod?: string
  idempotencyKeyPrefix?: string
  failureReason?: string
}
