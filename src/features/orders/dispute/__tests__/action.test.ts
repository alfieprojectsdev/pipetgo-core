// Unit tests for openDispute server action.
// Uses full Prisma mock (vi.fn()) scoped to the $transaction callback.
// Cases: non-owner reject, already-disputed reject, out-of-window reject,
// null-completedAt (legacy) reject, non-COMPLETED reject, CAS-miss reject, happy path.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { OrderStatus } from '@prisma/client'

const mockOrderFindUnique = vi.fn()
const mockOrderUpdateMany = vi.fn()
const mockOrderDisputeCreate = vi.fn()
const mockTx = {
  order: {
    findUnique: mockOrderFindUnique,
    updateMany: mockOrderUpdateMany,
  },
  orderDispute: {
    create: mockOrderDisputeCreate,
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn((cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
  },
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

vi.mock('@/domain/orders/dispute', () => ({
  isWithinDisputeWindow: vi.fn(),
}))

import { openDispute } from '../action'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'
import { isWithinDisputeWindow } from '@/domain/orders/dispute'

// auth has overloads — cast through Mock to avoid route-handler overload resolution
const mockAuth = auth as unknown as Mock
const mockIsValidStatusTransition = vi.mocked(isValidStatusTransition)
const mockIsWithinDisputeWindow = vi.mocked(isWithinDisputeWindow)

const CLIENT_SESSION = {
  user: { id: 'client-user-id', role: 'CLIENT' },
  expires: '2099-01-01',
}

const ORDER_ID = 'test-order-id'
const COMPLETED_AT = new Date('2026-05-01T10:00:00Z')

function makeFormData(orderId: string, reason: string) {
  const fd = new FormData()
  fd.append('orderId', orderId)
  fd.append('reason', reason)
  return fd
}

describe('openDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mockOrderFindUnique).not.toHaveBeenCalled()
  })

  it('returns Order not found when order.clientId does not match session', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'other-client-id',
      status: OrderStatus.COMPLETED,
      completedAt: COMPLETED_AT,
      dispute: null,
    })

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'Order not found.' })
    expect(mockOrderUpdateMany).not.toHaveBeenCalled()
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('returns already-opened message when a dispute already exists (one-per-order)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.COMPLETED,
      completedAt: COMPLETED_AT,
      dispute: { id: 'existing-dispute-id', orderId: ORDER_ID },
    })

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'A dispute has already been opened for this order.' })
    expect(mockIsWithinDisputeWindow).not.toHaveBeenCalled()
    expect(mockOrderUpdateMany).not.toHaveBeenCalled()
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('returns out-of-window error when completedAt is null (legacy order)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.COMPLETED,
      completedAt: null,
      dispute: null,
    })

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({
      message: 'Order has no completion timestamp — dispute window cannot be determined.',
    })
    expect(mockIsWithinDisputeWindow).not.toHaveBeenCalled()
    expect(mockOrderUpdateMany).not.toHaveBeenCalled()
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('returns out-of-window error when dispute window has passed', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.COMPLETED,
      completedAt: COMPLETED_AT,
      dispute: null,
    })
    mockIsWithinDisputeWindow.mockReturnValue(false)

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'The 14-day dispute window for this order has passed.' })
    expect(mockOrderUpdateMany).not.toHaveBeenCalled()
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('returns error when order status is not COMPLETED (non-COMPLETED reject)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.IN_PROGRESS,
      completedAt: COMPLETED_AT,
      dispute: null,
    })
    mockIsWithinDisputeWindow.mockReturnValue(true)
    mockIsValidStatusTransition.mockReturnValue(false)

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'Order cannot be disputed from its current status.' })
    expect(mockOrderUpdateMany).not.toHaveBeenCalled()
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('returns CAS-miss message and does not create a dispute when the transition affects 0 rows', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.COMPLETED,
      completedAt: COMPLETED_AT,
      dispute: null,
    })
    mockIsWithinDisputeWindow.mockReturnValue(true)
    mockIsValidStatusTransition.mockReturnValue(true)
    mockOrderUpdateMany.mockResolvedValue({ count: 0 })

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toEqual({ message: 'Order can no longer be disputed.' })
    expect(mockOrderDisputeCreate).not.toHaveBeenCalled()
  })

  it('creates OrderDispute and CAS-transitions order to DISPUTED on happy path', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mockOrderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      clientId: 'client-user-id',
      status: OrderStatus.COMPLETED,
      completedAt: COMPLETED_AT,
      dispute: null,
    })
    mockIsWithinDisputeWindow.mockReturnValue(true)
    mockIsValidStatusTransition.mockReturnValue(true)
    mockOrderUpdateMany.mockResolvedValue({ count: 1 })
    mockOrderDisputeCreate.mockResolvedValue({})

    const result = await openDispute(null, makeFormData(ORDER_ID, 'Test reason'))

    expect(result).toBeNull()
    expect(mockOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: OrderStatus.COMPLETED },
      data: { status: OrderStatus.DISPUTED },
    })
    expect(mockOrderDisputeCreate).toHaveBeenCalledWith({
      data: { orderId: ORDER_ID, reason: 'Test reason' },
    })
  })
})
