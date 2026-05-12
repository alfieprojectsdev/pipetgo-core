// Unit tests for retryPayment server action.
// Uses full Prisma mock (vi.fn()) and next/navigation redirect mock.
// Four branches: auth guard, ownership re-check, invalid status, happy path.
// redirect() throws NEXT_REDIRECT in Next.js — happy path asserts rejects.toThrow.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { OrderStatus } from '@prisma/client'

const mockOrderFindUnique = vi.fn()
const mockOrderUpdate = vi.fn()
const mockTx = {
  order: {
    findUnique: mockOrderFindUnique,
    update: mockOrderUpdate,
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn((cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
  },
}))

const mockRedirect = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}))

vi.mock('@/domain/orders/state-machine', () => ({
  isValidStatusTransition: vi.fn(),
}))

import { retryPayment } from '../action'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'

// auth has overloads — cast through Mock to avoid route-handler overload resolution
const mockAuth = auth as unknown as Mock
const mockIsValidStatusTransition = vi.mocked(isValidStatusTransition)

const CLIENT_SESSION = {
  user: { id: 'client-user-id', role: 'CLIENT' },
  expires: '2099-01-01',
}

const ORDER_ID = 'test-order-id'

function makeFormData(orderId: string) {
  const fd = new FormData()
  fd.append('orderId', orderId)
  return fd
}

describe('retryPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedirect.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' })
    })
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await retryPayment(null, makeFormData(ORDER_ID))

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mockOrderFindUnique).not.toHaveBeenCalled()
  })

  it('returns Order not found when order.clientId does not match session', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'other-client-id',
      status: OrderStatus.PAYMENT_FAILED,
    })

    const result = await retryPayment(null, makeFormData(ORDER_ID))

    expect(result).toEqual({ message: 'Order not found.' })
    expect(mockOrderUpdate).not.toHaveBeenCalled()
  })

  it('returns error message when status transition is invalid', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.QUOTE_PROVIDED,
    })
    mockIsValidStatusTransition.mockReturnValue(false)

    const result = await retryPayment(null, makeFormData(ORDER_ID))

    expect(result).toEqual({ message: 'Order cannot be retried from current status.' })
    expect(mockOrderUpdate).not.toHaveBeenCalled()
  })

  it('updates order to PAYMENT_PENDING and redirects to checkout on success', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.PAYMENT_FAILED,
    })
    mockIsValidStatusTransition.mockReturnValue(true)
    mockOrderUpdate.mockResolvedValue({})

    await expect(retryPayment(null, makeFormData(ORDER_ID))).rejects.toThrow('NEXT_REDIRECT')
    expect(mockOrderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      data: { status: OrderStatus.PAYMENT_PENDING },
    })
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/orders/${ORDER_ID}/pay`)
  })
})
