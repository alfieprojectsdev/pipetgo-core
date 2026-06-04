/**
 * Exhaustiveness guard for statusBadgeConfig (R-002).
 *
 * Iterates every OrderStatus enum member via Object.values and asserts that
 * statusBadgeConfig has a defined, non-fallback entry for each — so a future
 * enum member added without a badge entry fails this test, not just tsc.
 *
 * The ?? fallback on the badge lookup in page.tsx is intentional deploy-safety
 * for the migration<->client-regen window (ref: DL-008). This test verifies
 * that the fallback is never actually reached for any known enum member.
 */
import { describe, it, expect } from 'vitest'
import { OrderStatus } from '@prisma/client'

// page.tsx mocks — the RSC page imports server-only modules (prisma, auth,
// next/navigation). Mock them so the module can be loaded in a unit test.
import { vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('server-only', () => ({}))

// Import after mocks are in place.
const { statusBadgeConfig } = await import('../page')

describe('statusBadgeConfig exhaustiveness (R-002)', () => {
  it('has a defined entry for every OrderStatus enum member', () => {
    const allStatuses = Object.values(OrderStatus)

    for (const status of allStatuses) {
      const entry = statusBadgeConfig[status]
      expect(entry, `statusBadgeConfig missing entry for OrderStatus.${status}`).toBeDefined()
      expect(typeof entry.label, `statusBadgeConfig[${status}].label is not a string`).toBe('string')
      expect(entry.label.length, `statusBadgeConfig[${status}].label is empty`).toBeGreaterThan(0)
      expect(typeof entry.className, `statusBadgeConfig[${status}].className is not a string`).toBe('string')
    }
  })

  it('DISPUTED entry specifically has a defined label and className', () => {
    const disputed = statusBadgeConfig[OrderStatus.DISPUTED]
    expect(disputed).toBeDefined()
    expect(disputed.label).toBe('Disputed')
    expect(disputed.className).toContain('amber')
  })
})
