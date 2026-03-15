/**
 * Domain logic for determining the initial state of a new order based on
 * service pricing configuration.
 *
 * FIXED and HYBRID (no custom quote) resolve to PAYMENT_PENDING, not PENDING.
 * PENDING is never the initial state; it is only reachable via quote approval. (ref: DL-009)
 * QUOTE_REQUIRED and HYBRID (custom quote) resolve to QUOTE_REQUESTED with no
 * price set.
 */
import { LabService, OrderStatus, PricingMode } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

type ServicePricingFields = Pick<LabService, "pricingMode" | "pricePerUnit">;

type InitialOrderState = {
  status: OrderStatus;
  quotedPrice: Decimal | null;
  quotedAt: Date | null;
};

/**
 * Returns the initial status, quotedPrice, and quotedAt for a new order.
 *
 * For FIXED mode: sets status to PAYMENT_PENDING with the service list price
 * and timestamps quotedAt to now. For HYBRID without a custom quote request,
 * applies the same FIXED-mode path. (ref: DL-009)
 */
export function resolveOrderInitialState(
  service: ServicePricingFields,
  requestCustomQuote: boolean | undefined,
): InitialOrderState {
  switch (service.pricingMode) {
    case PricingMode.QUOTE_REQUIRED:
      return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };

    case PricingMode.FIXED:
      return {
        status: OrderStatus.PAYMENT_PENDING,
        quotedPrice: service.pricePerUnit,
        quotedAt: new Date(),
      };

    case PricingMode.HYBRID:
      if (requestCustomQuote) {
        return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };
      }
      return {
        status: OrderStatus.PAYMENT_PENDING,
        quotedPrice: service.pricePerUnit,
        quotedAt: new Date(),
      };

    default:
      return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };
  }
}
