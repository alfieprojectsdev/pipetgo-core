// Three-case fence for z.literal(true): false-rejection and missing-rejection lock the literal
// semantics so a refactor downgrading to z.boolean() cannot pass tests green. (ref: DL-010)
// Enum-drift fence covers every ServiceCategory member; compile-time satisfies guard + runtime length check. (ref: DL-011)
import { describe, it, expect } from "vitest"
import { ServiceCategory } from "@prisma/client"
import { clientDetailsSchema, SENSITIVE_SERVICE_CATEGORIES, isSensitiveServiceCategory } from "../client-details"

const validContact = {
  name: "Test Client",
  email: "test@example.com",
  phone: "+639171234567",
}

describe("clientDetailsSchema — RA 10173 consent", () => {
  it("rejects when consentGiven is false", () => {
    const result = clientDetailsSchema.safeParse({ ...validContact, consentGiven: false })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.consentGiven).toBeDefined()
    }
  })

  it("rejects when consentGiven is missing", () => {
    const result = clientDetailsSchema.safeParse(validContact)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.consentGiven).toBeDefined()
    }
  })

  it("accepts when consentGiven is true", () => {
    const result = clientDetailsSchema.safeParse({ ...validContact, consentGiven: true as const })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.consentGiven).toBe(true)
    }
  })
})

describe("SENSITIVE_SERVICE_CATEGORIES — enum-drift fence (DL-011)", () => {
  it("classifies CHEMICAL_TESTING and BIOLOGICAL_TESTING as sensitive and the remaining four categories as non-sensitive", () => {
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CHEMICAL_TESTING]).toBe(true)
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.BIOLOGICAL_TESTING]).toBe(true)
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.PHYSICAL_TESTING]).toBe(false)
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.ENVIRONMENTAL_TESTING]).toBe(false)
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CALIBRATION]).toBe(false)
    expect(SENSITIVE_SERVICE_CATEGORIES[ServiceCategory.CERTIFICATION]).toBe(false)
  })

  it("covers every ServiceCategory enum member (compile-time satisfies guard + runtime length fence)", () => {
    expect(Object.keys(SENSITIVE_SERVICE_CATEGORIES).sort()).toEqual(
      Object.values(ServiceCategory).sort()
    )
  })

  it("isSensitiveServiceCategory returns true for CHEMICAL_TESTING and false for CALIBRATION", () => {
    expect(isSensitiveServiceCategory(ServiceCategory.CHEMICAL_TESTING)).toBe(true)
    expect(isSensitiveServiceCategory(ServiceCategory.CALIBRATION)).toBe(false)
  })
})
