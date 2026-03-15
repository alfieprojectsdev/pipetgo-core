/**
 * Exhaustive transition map for OrderStatus. Each key lists the statuses
 * reachable from that state; an empty array marks a terminal state.
 *
 * PAYMENT_PENDING is reachable from PENDING (quote approved or FIXED auto-price)
 * and from PAYMENT_FAILED (retry). COMPLETED is the only entry point to the
 * refund path. (ref: DL-006, DL-007)
 */
import { OrderStatus } from "@prisma/client";

export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.QUOTE_REQUESTED]: [OrderStatus.QUOTE_PROVIDED, OrderStatus.CANCELLED],
  [OrderStatus.QUOTE_PROVIDED]: [
    OrderStatus.QUOTE_REJECTED,
    OrderStatus.PENDING,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.QUOTE_REJECTED]: [OrderStatus.QUOTE_REQUESTED],
  [OrderStatus.PENDING]: [
    OrderStatus.PAYMENT_PENDING,
    // ACKNOWLEDGED path: FIXED-mode orders that bypassed payment (backward-state guard).
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PAYMENT_PENDING]: [
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PAYMENT_FAILED]: [OrderStatus.PAYMENT_PENDING, OrderStatus.CANCELLED],
  [OrderStatus.ACKNOWLEDGED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_PENDING],
  [OrderStatus.REFUND_PENDING]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.CANCELLED]: [],
};

// Single enforcement point for status transitions. Every Server Action and webhook
// handler that mutates OrderStatus must call this guard; direct status writes bypass it.
export function isValidStatusTransition(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return validStatusTransitions[from].includes(to);
}
