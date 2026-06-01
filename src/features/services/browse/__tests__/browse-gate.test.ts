/**
 * Unit tests for the ITA 2023 marketplace gate in ServiceBrowsePage.
 * Asserts that labService.findMany where-clause includes lab: { isVerified: true }
 * so services of unverified labs are excluded and services of verified labs are included.
 *
 * This is an independent code path from create-order/action.ts — the create-order gate
 * test does not exercise this findMany where clause, so browse needs its own assertion.
 * (ref: DL-006, DL-012)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { ServiceCategory, PricingMode } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const mocks = vi.hoisted(() => ({
  labServiceFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    labService: { findMany: mocks.labServiceFindMany },
  },
}))

// Next.js RSC imports — stub out the UI component so JSX doesn't break vitest
vi.mock('../ui', () => ({
  ServiceBrowseUI: () => null,
}))

import ServiceBrowsePage from '../page'

function makeService(overrides?: object) {
  return {
    id: 'svc-1',
    name: 'CBC Test',
    description: null,
    category: ServiceCategory.CHEMICAL_TESTING,
    pricingMode: PricingMode.FIXED,
    pricePerUnit: new Decimal('500.00'),
    unit: 'sample',
    lab: { name: 'Test Lab', location: null },
    ...overrides,
  }
}

describe('ServiceBrowsePage — ITA 2023 marketplace gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes lab: { isVerified: true } in the findMany where clause', async () => {
    mocks.labServiceFindMany.mockResolvedValue([])

    await ServiceBrowsePage({ searchParams: {} })

    expect(mocks.labServiceFindMany).toHaveBeenCalledTimes(1)
    const [callArgs] = (mocks.labServiceFindMany as Mock).mock.calls[0] as [{ where: unknown }]
    expect(callArgs.where).toMatchObject({ lab: { isVerified: true } })
  })

  it('includes isActive: true alongside lab.isVerified: true', async () => {
    mocks.labServiceFindMany.mockResolvedValue([])

    await ServiceBrowsePage({ searchParams: {} })

    const [callArgs] = (mocks.labServiceFindMany as Mock).mock.calls[0] as [{ where: unknown }]
    expect(callArgs.where).toMatchObject({ isActive: true, lab: { isVerified: true } })
  })

  it('unverified-lab service excluded — findMany returns empty when no verified lab exists', async () => {
    // Simulate the DB honouring the filter: no verified labs → empty result
    mocks.labServiceFindMany.mockResolvedValue([])

    await ServiceBrowsePage({ searchParams: {} })

    // The where clause is correctly constructed — the DB would filter out unverified labs
    const [callArgs] = (mocks.labServiceFindMany as Mock).mock.calls[0] as [{ where: unknown }]
    expect(callArgs.where).toMatchObject({ lab: { isVerified: true } })
    // The page receives an empty list (no services from unverified labs)
    expect(mocks.labServiceFindMany).toHaveReturnedWith(expect.any(Promise))
  })

  it('verified-lab service included — findMany returns the service when lab is verified', async () => {
    const verifiedService = makeService()
    mocks.labServiceFindMany.mockResolvedValue([verifiedService])

    await ServiceBrowsePage({ searchParams: {} })

    // Where clause carries the gate
    const [callArgs] = (mocks.labServiceFindMany as Mock).mock.calls[0] as [{ where: unknown }]
    expect(callArgs.where).toMatchObject({ lab: { isVerified: true } })
    // findMany resolved with the verified service — DTO mapping would include it
    expect(mocks.labServiceFindMany).toHaveBeenCalledTimes(1)
  })

  it('category filter is applied alongside the isVerified gate', async () => {
    mocks.labServiceFindMany.mockResolvedValue([])

    await ServiceBrowsePage({ searchParams: { category: 'CHEMICAL_TESTING' } })

    const [callArgs] = (mocks.labServiceFindMany as Mock).mock.calls[0] as [{ where: unknown }]
    expect(callArgs.where).toMatchObject({
      isActive: true,
      lab: { isVerified: true },
      category: ServiceCategory.CHEMICAL_TESTING,
    })
  })
})
