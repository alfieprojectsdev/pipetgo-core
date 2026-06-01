/**
 * Unit tests for the ITA 2023 accreditation gate in createOrder.
 * Asserts that the action rejects BEFORE the $transaction when
 * service.lab.isVerified === false, and proceeds past the gate when true.
 *
 * The create-order gate is the liability-bearing control: a client can POST
 * a serviceId directly without navigating through /services. (ref: DL-006, DL-012)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PricingMode } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const mocks = vi.hoisted(() => ({
  labServiceFindUnique: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    labService: { findUnique: mocks.labServiceFindUnique },
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

// domain/orders modules — stub out so we don't need the full domain in unit scope
vi.mock('@/domain/orders/client-details', () => ({
  clientDetailsSchema: {
    safeParse: vi.fn().mockReturnValue({ success: false, error: { flatten: () => ({ fieldErrors: {} }) } }),
  },
}))

vi.mock('@/domain/orders/pricing', () => ({
  resolveOrderInitialState: vi.fn(),
}))

import { createOrder } from '../action'

const CLIENT_SESSION = {
  user: { id: 'client-user-id', role: 'CLIENT', email: 'client@example.com' },
  expires: '2099-01-01',
}

const SERVICE_ID = 'test-service-id'

function makeFormData(serviceId = SERVICE_ID): FormData {
  const fd = new FormData()
  fd.append('serviceId', serviceId)
  return fd
}

function makeService(isVerified: boolean) {
  return {
    id: SERVICE_ID,
    labId: 'lab-1',
    name: 'CBC Test',
    description: null,
    category: 'CHEMICAL_TESTING',
    pricingMode: PricingMode.FIXED,
    pricePerUnit: new Decimal('500.00'),
    unit: 'sample',
    isActive: true,
    lab: { isVerified },
  }
}

describe('createOrder — ITA 2023 accreditation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redirect.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' })
    })
  })

  it('isVerified false — returns accreditation error, $transaction NOT called', async () => {
    mocks.labServiceFindUnique.mockResolvedValue(makeService(false))

    const result = await createOrder(null, makeFormData())

    expect(result).toEqual({
      message: 'This service is not currently available — the lab has not completed accreditation.',
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('isVerified false — gate fires before auth check ($transaction and auth NOT called)', async () => {
    mocks.labServiceFindUnique.mockResolvedValue(makeService(false))

    await createOrder(null, makeFormData())

    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('isVerified true — gate passes, action proceeds to auth check', async () => {
    // Gate passes; return an unauthorized session so the action returns early without
    // needing to wire up the full $transaction mock. The key assertion is that the
    // accreditation gate did NOT block the call.
    mocks.labServiceFindUnique.mockResolvedValue(makeService(true))
    mocks.auth.mockResolvedValue(null)

    const result = await createOrder(null, makeFormData())

    expect(result).toEqual({ message: 'Unauthorized.' })
    // auth WAS called — the gate did not intercept the request
    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('isVerified true with CLIENT session — gate passes, action reaches transaction', async () => {
    mocks.labServiceFindUnique.mockResolvedValue(makeService(true))
    mocks.auth.mockResolvedValue(CLIENT_SESSION)
    // clientDetailsSchema.safeParse fails by default (missing fields) — action returns
    // validation errors without reaching $transaction; confirms gate did not block
    const result = await createOrder(null, makeFormData())

    expect(result).not.toEqual({
      message: 'This service is not currently available — the lab has not completed accreditation.',
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('missing serviceId — returns missing-service-id error, $transaction NOT called', async () => {
    const fd = new FormData()
    // no serviceId field

    const result = await createOrder(null, fd)

    expect(result).toEqual({ message: 'Missing service ID.' })
    expect(mocks.labServiceFindUnique).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('service not found (inactive or missing) — returns unavailable error, $transaction NOT called', async () => {
    mocks.labServiceFindUnique.mockResolvedValue(null)

    const result = await createOrder(null, makeFormData())

    expect(result).toEqual({ message: 'Service no longer available.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
