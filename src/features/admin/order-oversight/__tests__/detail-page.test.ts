import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  auth: vi.fn(),
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { findUnique: mocks.orderFindUnique },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}))

import AdminOrderDetailPage from '../detail-page'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = { user: { id: 'admin-1', role: 'ADMIN' }, expires: '2099-01-01' }

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    status: 'COMPLETED' as const,
    quotedPrice: null,
    quotedAt: null,
    paidAt: null,
    refundedAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    lab: { name: 'Lab A', id: 'lab-1' },
    service: { name: 'Service A', id: 'svc-1' },
    client: { id: 'client-1', name: 'Alice', email: 'alice@example.com' },
    clientProfile: null,
    transactions: [],
    payouts: [],
    attachments: [],
    ...overrides,
  }
}

describe('AdminOrderDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects non-ADMIN session', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
    await expect(AdminOrderDetailPage({ params: { orderId: 'order-1' } })).rejects.toThrow('NEXT_REDIRECT')
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/signin')
  })

  it('calls notFound when order is null', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue(null)
    await expect(AdminOrderDetailPage({ params: { orderId: 'missing' } })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.notFound).toHaveBeenCalled()
  })

  it('throws when order.lab is null after explicit include', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder({ lab: null }))
    await expect(
      AdminOrderDetailPage({ params: { orderId: 'order-1' } }),
    ).rejects.toThrow(/referential integrity violation/i)
    expect(mocks.notFound).not.toHaveBeenCalled()
  })

  it('returns DTO with string amount and ISO date strings for valid order', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    const { Decimal } = await import('@prisma/client/runtime/library')
    mocks.orderFindUnique.mockResolvedValue(
      makeOrder({
        quotedPrice: new Decimal('200.00'),
        quotedAt: new Date('2024-02-01T00:00:00.000Z'),
        paidAt: new Date('2024-02-02T00:00:00.000Z'),
        transactions: [
          {
            id: 'txn-1',
            amount: new Decimal('200.00'),
            status: 'CAPTURED',
            paymentMethod: 'card',
            capturedAt: new Date('2024-02-02T00:00:00.000Z'),
            createdAt: new Date('2024-02-01T00:00:00.000Z'),
          },
        ],
        payouts: [
          {
            id: 'payout-1',
            grossAmount: new Decimal('190.00'),
            platformFee: new Decimal('19.00'),
            netAmount: new Decimal('171.00'),
            feePercentage: new Decimal('0.1000'),
            status: 'COMPLETED',
            scheduledDate: null,
            completedAt: new Date('2024-02-10T00:00:00.000Z'),
            createdAt: new Date('2024-02-03T00:00:00.000Z'),
          },
        ],
      }),
    )
    const jsx = await AdminOrderDetailPage({ params: { orderId: 'order-1' } })
    const dto = jsx.props.dto as Record<string, unknown>
    expect(typeof dto.quotedPrice).toBe('string')
    expect(typeof dto.createdAt).toBe('string')
    const txn = (dto.transactions as Array<Record<string, unknown>>)[0]
    expect(typeof txn.amount).toBe('string')
    expect(typeof txn.capturedAt).toBe('string')
    const payout = (dto.payouts as Array<Record<string, unknown>>)[0]
    expect(typeof payout.grossAmount).toBe('string')
    expect(typeof payout.netAmount).toBe('string')
    expect(typeof payout.completedAt).toBe('string')
  })
})
