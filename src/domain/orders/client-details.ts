/**
 * Zod validation schema for client contact data captured at order creation.
 *
 * Coexists with the ClientProfile Prisma model: this schema validates at the
 * Server Action boundary; the Prisma model persists the normalized record.
 * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
 *
 * consentGiven must remain z.literal(true) — not z.boolean() — so an unchecked box
 * fails safeParse at the domain boundary and blocks submission without a second guard
 * in the action. Downgrading to z.boolean() silently breaks the RA 10173 invariant.
 */
import { z } from "zod";
import { ServiceCategory } from "@prisma/client";

export const clientDetailsSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  phone: z
    .string()
    .min(10)
    .max(20)
    .regex(/^[0-9\s\-+()]+$/),
  organization: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  // z.literal(true): false or absent both fail safeParse, surfacing as a field-level error. (ref: DL-002)
  consentGiven: z.literal(true, {
    errorMap: () => ({ message: "Privacy consent is required for the data controller to lawfully process your order under RA 10173." }),
  }),
});

export type ClientDetails = z.infer<typeof clientDetailsSchema>;

// Compile-time enum-drift fence: adding a new ServiceCategory member triggers a TypeScript
// error here until it is classified. Prevents silent omission from /privacy and slice README. (ref: DL-011)
export const SENSITIVE_SERVICE_CATEGORIES = {
  CHEMICAL_TESTING: true,
  BIOLOGICAL_TESTING: true,
  PHYSICAL_TESTING: false,
  ENVIRONMENTAL_TESTING: false,
  CALIBRATION: false,
  CERTIFICATION: false,
} as const satisfies Record<ServiceCategory, boolean>;

export function isSensitiveServiceCategory(category: ServiceCategory): boolean {
  return SENSITIVE_SERVICE_CATEGORIES[category];
}
