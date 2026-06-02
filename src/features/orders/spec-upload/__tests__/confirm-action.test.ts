// Tests for confirmSpecUpload: covers CLIENT role gate, ownership guard,
// idempotent CAS updateMany behavior, count===0 early-return, and revalidatePath call. (ref: DL-002)

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderFindUnique:      vi.fn(),
  attachmentUpdateMany: vi.fn(),
  transaction:          vi.fn(),
  auth:                 vi.fn(),
  revalidatePath:       vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const mockTx = {
    attachment: { updateMany: mocks.attachmentUpdateMany },
  }
  return {
    prisma: {
      order: { findUnique: mocks.orderFindUnique },
      $transaction: mocks.transaction.mockImplementation(
        (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
      ),
    },
  }
})

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

import { confirmSpecUpload } from '../confirm-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const CLIENT_SESSION = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }
const MOCK_ORDER     = { clientId: 'client-1' }

function makeFormData(attachmentId = 'att-1', orderId = 'ord-1'): FormData {
  const fd = new FormData()
  fd.append('attachmentId', attachmentId)
  fd.append('orderId',      orderId)
  return fd
}

describe('confirmSpecUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (cb: (tx: { attachment: { updateMany: Mock } }) => Promise<unknown>) =>
        cb({ attachment: { updateMany: mocks.attachmentUpdateMany } }),
    )
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 })
    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
  })

  it('returns Unauthorized for non-CLIENT role, transaction not called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
    const result = await confirmSpecUpload(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await confirmSpecUpload(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error when order not found, transaction not called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(null)
    const result = await confirmSpecUpload(null, makeFormData())
    expect(result).toEqual({ message: 'Order not found.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error when order belongs to different client, transaction not called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ clientId: 'other-client' })
    const result = await confirmSpecUpload(null, makeFormData())
    expect(result).toEqual({ message: 'Order not found.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('attachment.updateMany called with CAS guard {id, orderId}', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    await confirmSpecUpload(null, makeFormData('att-1', 'ord-1'))
    expect(mocks.attachmentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'att-1', orderId: 'ord-1' },
      data:  {},
    })
  })

  it('count===0: returns error message — attachment not found or cross-order', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 })
    const result = await confirmSpecUpload(null, makeFormData())
    expect(result).toEqual({ message: 'Attachment not found.' })
  })

  it('success: revalidatePath called for order and returns null', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const result = await confirmSpecUpload(null, makeFormData('att-1', 'ord-1'))
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/orders/ord-1')
    expect(result).toBeNull()
  })

  it('missing attachmentId returns error without touching prisma', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const fd = new FormData()
    fd.append('orderId', 'ord-1')
    const result = await confirmSpecUpload(null, fd)
    expect(result).toEqual({ message: 'Missing field.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('missing orderId returns error without touching prisma', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const fd = new FormData()
    fd.append('attachmentId', 'att-1')
    const result = await confirmSpecUpload(null, fd)
    expect(result).toEqual({ message: 'Missing field.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
