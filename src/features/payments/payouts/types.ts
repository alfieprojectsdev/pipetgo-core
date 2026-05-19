/**
 * Shape of the Xendit sub-account split settlement webhook payload.
 * Shared by route.ts (parse + cast) and handlers.ts (process).
 *
 * Field names and values are provisional — assumed from Xendit invoice webhook
 * conventions (docs/research/Payment-Processor-eval-PipetGo.md). Each field
 * carries a per-field TODO(AC-006) comment; all must be confirmed against the
 * Xendit sub-account settlement sandbox before merge. (ref: DL-010)
 */
export interface XenditSettlementPayload {
  /** Xendit settlement transfer ID — maps to Payout.externalPayoutId (@unique). */
  // TODO(AC-006): confirm Xendit settlement payload field is named "id". (ref: R-001)
  id: string

  /** Settlement status — uppercase-normalized before route.ts dispatch. */
  // TODO(AC-006): confirm Xendit settlement status string is "COMPLETED" not "SUCCEEDED". (ref: R-002)
  status: string

  /** Gross settlement amount. Used for logging only; ledger math uses Payout.platformFee. */
  // TODO(AC-006): confirm field name is "amount" and whether unit is PHP pesos or centavos. (ref: R-001)
  amount: number

  /** orderId sent to Xendit at sub-account invoice creation — first-delivery Payout lookup key. */
  // TODO(AC-006): confirm Xendit settlement payload field is named "external_id". (ref: R-001)
  external_id: string
}
