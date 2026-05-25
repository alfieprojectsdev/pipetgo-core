/**
 * Provider-agnostic domain event types for webhook-driven payment transitions.
 *
 * These types define the contract between the payments/ domain subdomain and
 * feature-slice webhook handlers. Webhook routes verify provider signatures, parse
 * the raw provider payload, dispatch by status, normalize via per-provider adapters
 * (src/features/payments/webhooks/types.ts), and produce these typed events inside
 * Prisma.$transaction. Provider-specific auth concerns live in
 * src/lib/payments/webhook-auth.ts, not here.
 *
 */
import { Decimal } from "@prisma/client/runtime/library";

export interface PaymentCapturedEvent {
  orderId: string;
  transactionId: string;
  amount: Decimal;
  gatewayRef: string;
  // gatewayRef is captured here so dispute resolution and payout reconciliation
  // can reference the gateway record without an additional provider query.
  capturedAt: Date;
  // paymentMethod carried on the event so orders slice can write Order.paymentMethod
  // without querying the Transaction model directly (cross-slice boundary).
  paymentMethod?: string;
}

export interface PaymentFailedEvent {
  orderId: string;
  transactionId: string;
  failureReason: string;
  failedAt: Date;
}
