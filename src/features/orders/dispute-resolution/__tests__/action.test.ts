/**
 * Unit tests for resolveDispute server action.
 * Uses full Prisma mock with transaction callback.
 * Mock method names match handler calls exactly (CLAUDE.md discipline):
 *   orderUpdateMany -> tx.order.updateMany
 *   orderDisputeUpdate -> tx.orderDispute.update
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderUpdateMany: vi.fn(),
  orderDisputeUpdate: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const mockTx = {
    order: { updateMany: mocks.orderUpdateMany },
    orderDispute: { update: mocks.orderDisputeUpdate },
  }
  return {
    prisma: {
      $transaction: mocks.transaction.mockImplementation(
        (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
      ),
    },
  }
})

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

import { resolveDispute } from '../action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = {
  user: { id: 'admin-user-1', role: 'ADMIN' },
  expires: '2099-01-01',
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, v)
  }
  return fd
}

describe('resolveDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (
        cb: (tx: {
          order: { updateMany: Mock }
          orderDispute: { update: Mock }
        }) => Promise<unknown>,
      ) =>
        cb({
          order: { updateMany: mocks.orderUpdateMany },
          orderDispute: { update: mocks.orderDisputeUpdate },
        }),
    )
    mocks.orderUpdateMany.mockResolvedValue({ count: 1 })
    mocks.orderDisputeUpdate.mockResolvedValue({})
  })

  it('returns Unauthorized when session is absent — no transaction called', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_COMPLETED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN — no transaction called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })

    const result = await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_COMPLETED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error for invalid resolution value — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'INVALID_VALUE' }),
    )

    expect(result).toEqual({ message: 'Invalid resolution value.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('RESOLVED_COMPLETED — sets status COMPLETED + writes resolution fields via updateMany CAS + orderDispute.update', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_COMPLETED' }),
    )

    expect(mocks.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'DISPUTED' },
      data: { status: 'COMPLETED' },
    })

    expect(mocks.orderDisputeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order-1' },
        data: expect.objectContaining({
          resolution: 'RESOLVED_COMPLETED',
          resolvedById: 'admin-user-1',
        }),
      }),
    )

    const disputeCall = mocks.orderDisputeUpdate.mock.calls[0][0] as {
      data: { resolvedAt: Date }
    }
    expect(disputeCall.data.resolvedAt).toBeInstanceOf(Date)
  })

  it('RESOLVED_REFUND — sets status REFUND_PENDING + writes resolution fields via updateMany CAS + orderDispute.update', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_REFUND' }),
    )

    expect(mocks.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'DISPUTED' },
      data: { status: 'REFUND_PENDING' },
    })

    expect(mocks.orderDisputeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order-1' },
        data: expect.objectContaining({
          resolution: 'RESOLVED_REFUND',
          resolvedById: 'admin-user-1',
        }),
      }),
    )
  })

  it('CAS count===0 — returns idempotent message and orderDispute.update NOT called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderUpdateMany.mockResolvedValue({ count: 0 })

    const result = await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_COMPLETED' }),
    )

    expect(result).toEqual({
      message: 'Order is no longer in DISPUTED status — resolution may have already been recorded.',
    })
    expect(mocks.orderDisputeUpdate).not.toHaveBeenCalled()
  })

  it('successful RESOLVED_COMPLETED — calls revalidatePath and redirect', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await resolveDispute(
      null,
      makeFormData({ orderId: 'order-1', resolution: 'RESOLVED_COMPLETED' }),
    )

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/admin/disputes')
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard/admin/disputes')
  })
})
