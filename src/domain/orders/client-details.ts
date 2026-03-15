/**
 * Zod validation schema for client contact data captured at order creation.
 *
 * Coexists with the ClientProfile Prisma model: this schema validates at the
 * Server Action boundary; the Prisma model persists the normalized record.
 * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
 */
import { z } from "zod";

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
});

export type ClientDetails = z.infer<typeof clientDetailsSchema>;
