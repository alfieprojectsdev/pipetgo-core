/**
 * Commission rate constants for the AD-001 Direct Payment model.
 *
 * Under AD-001, Xendit Managed Sub-Accounts split the PipetGo commission at
 * settlement. COMMISSION_RATE is the single global rate applied to every
 * completed order; the Payout record captures confirmed commission when an
 * order reaches COMPLETED.
 *
 * TODO: per-lab or per-service rates from Lab.commissionRate or a contract
 * table — deferred until contract negotiation requires variation. (ref: DL-002)
 */
import { Decimal } from "@prisma/client/runtime/library";

// String-constructed to preserve exact scale matching Payout.feePercentage Decimal(5,4). (ref: DL-005)
export const COMMISSION_RATE = new Decimal("0.1000");
