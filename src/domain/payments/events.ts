/**
 * Domain event types for PayMongo webhook-driven payment transitions.
 *
 * These types define the contract between the payments/ domain subdomain and
 * feature slice webhook handlers. Webhook routes dispatch raw PayMongo payloads
 * into these typed events; feature slice handlers execute the resulting state
 * transitions inside a Prisma.$transaction. (ref: DL-011)
 *
 * NOTE: PayMongo webhook signature verification requires reading the raw request
 * body as text before JSON parsing. Re-serializing a parsed body breaks the
 * HMAC-SHA256 comparison.
 */
import { Decimal } from "@prisma/client/runtime/library";

export interface PaymentCapturedEvent {
  orderId: string;
  transactionId: string;
  amount: Decimal;
  gatewayRef: string;
  // gatewayRef is captured here so dispute resolution and payout reconciliation
  // can reference the gateway record without re-querying PayMongo.
  capturedAt: Date;
  // paymentMethod carried on the event so orders slice can write Order.paymentMethod
  // without querying the Transaction model (cross-slice boundary violation). (ref: DL-009)
  paymentMethod?: string;
}

export interface PaymentFailedEvent {
  orderId: string;
  transactionId: string;
  failureReason: string;
  failedAt: Date;
}
