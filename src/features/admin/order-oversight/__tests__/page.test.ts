import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderFindMany: vi.fn(),
  auth: vi.fn(),
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { findMany: mocks.orderFindMany },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

import AdminOrderListPage from '../page'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = { user: { id: 'admin-1', role: 'ADMIN' }, expires: '2099-01-01' }
const PAGE_SIZE = 25

function makeOrder(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'PENDING' as const,
    quotedPrice: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    lab: { name: 'Lab A' },
    clientProfile: { name: 'Client A' },
    ...overrides,
  }
}

describe('AdminOrderListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects non-ADMIN session and does not query', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
    await expect(AdminOrderListPage({ searchParams: {} })).rejects.toThrow('NEXT_REDIRECT')
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/signin')
    expect(mocks.orderFindMany).not.toHaveBeenCalled()
  })

  it('forward with no cursor passes desc orderBy and take=PAGE_SIZE+1 with no cursor arg', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderFindMany.mockResolvedValue([])
    await AdminOrderListPage({ searchParams: {} })
    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
      }),
    )
    const call = mocks.orderFindMany.mock.calls[0][0] as Record<string, unknown>
    expect(call).not.toHaveProperty('cursor')
  })

  it('forward with cursor passes desc orderBy plus cursor and skip:1', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderFindMany.mockResolvedValue([])
    await AdminOrderListPage({ searchParams: { cursor: 'abc', dir: 'next' } })
    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        cursor: { id: 'abc' },
        skip: 1,
      }),
    )
  })

  it('dir=prev with cursor passes reversed asc orderBy and cursor/skip', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    const orders = [makeOrder('id-2'), makeOrder('id-1')]
    mocks.orderFindMany.mockResolvedValue(orders)
    const result = await AdminOrderListPage({ searchParams: { cursor: 'id-0', dir: 'prev' } })
    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE + 1,
        cursor: { id: 'id-0' },
        skip: 1,
      }),
    )
    // result is JSX; check it renders without throwing
    expect(result).toBeDefined()
  })

  it('forward result of PAGE_SIZE+1 yields PAGE_SIZE rows with showNext=true and extra row dropped', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    const extraRow = makeOrder('extra')
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => makeOrder(`id-${i}`))
    mocks.orderFindMany.mockResolvedValue([...rows, extraRow])
    const jsx = await AdminOrderListPage({ searchParams: {} })
    // jsx.props.rows should have PAGE_SIZE entries, showNext=true
    expect(jsx.props.rows).toHaveLength(PAGE_SIZE)
    expect(jsx.props.showNext).toBe(true)
    expect(jsx.props.rows.find((r: { id: string }) => r.id === 'extra')).toBeUndefined()
  })

  it('DTO mapping serializes quotedPrice and createdAt to strings', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    const { Decimal } = await import('@prisma/client/runtime/library')
    mocks.orderFindMany.mockResolvedValue([
      makeOrder('id-1', {
        quotedPrice: new Decimal('150.50'),
        createdAt: new Date('2024-06-01T12:00:00.000Z'),
      }),
    ])
    const jsx = await AdminOrderListPage({ searchParams: {} })
    const row = jsx.props.rows[0] as Record<string, unknown>
    expect(typeof row.quotedPrice).toBe('string')
    expect(typeof row.createdAt).toBe('string')
    expect(row.quotedPrice).toBe('150.50')
    expect(row.createdAt).toBe('2024-06-01T12:00:00.000Z')
  })

  it('DTO row contains no client email or phone keys (PII minimization)', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.orderFindMany.mockResolvedValue([makeOrder('id-1')])
    const jsx = await AdminOrderListPage({ searchParams: {} })
    const row = jsx.props.rows[0] as Record<string, unknown>
    expect(row).not.toHaveProperty('email')
    expect(row).not.toHaveProperty('phone')
    expect(row).not.toHaveProperty('address')
  })

  it('backward traversal reverses rows to restore desc display order', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    // Prisma returns asc order for prev; page should reverse to desc
    const asc = [makeOrder('id-1'), makeOrder('id-2'), makeOrder('id-3')]
    mocks.orderFindMany.mockResolvedValue(asc)
    const jsx = await AdminOrderListPage({ searchParams: { cursor: 'id-0', dir: 'prev' } })
    const rows = jsx.props.rows as Array<{ id: string }>
    expect(rows[0].id).toBe('id-3')
    expect(rows[rows.length - 1].id).toBe('id-1')
  })
})
