// Tests for viewResultAttachment: covers LAB_ADMIN role gate, ownerId guard
// via order.lab.ownerId, and presigned GET URL generation. (ref: DL-009)

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachmentFindUnique:    vi.fn(),
  auth:                    vi.fn(),
  generatePresignedGetUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    attachment: { findUnique: mocks.attachmentFindUnique },
  },
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))

vi.mock('@/lib/storage/r2', () => ({
  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
}))

import { viewResultAttachment } from '../view-attachment-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const LAB_ADMIN_SESSION = { user: { id: 'lab-owner-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }

describe('viewResultAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await viewResultAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Unauthorized for non-LAB_ADMIN role', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
    const result = await viewResultAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
  })

  it('returns error when attachment not found', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue(null)
    const result = await viewResultAttachment('att-missing')
    expect(result).toEqual({ message: 'Attachment not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when attachment belongs to different lab owner', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/result.pdf',
      order: { lab: { ownerId: 'other-owner' } },
    })
    const result = await viewResultAttachment('att-1')
    expect(result).toEqual({ message: 'Attachment not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('throws when order relation is null after explicit include (RI violation)', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/result.pdf', order: null })
    await expect(viewResultAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
  })

  it('throws when order.lab relation is null after explicit include (RI violation)', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/result.pdf',
      order: { lab: null },
    })
    await expect(viewResultAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
  })

  it('returns presigned URL for attachment owned by lab', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/result.pdf',
      order: { lab: { ownerId: 'lab-owner-1' } },
    })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')

    const result = await viewResultAttachment('att-1')

    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
      where:  { id: 'att-1' },
      select: {
        r2Key: true,
        order: { select: { lab: { select: { ownerId: true } } } },
      },
    })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/result.pdf', { allowedPrefix: 'orders/' })
    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
  })

  it('returns error when DB lookup throws', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockRejectedValue(new Error('DB error'))
    const result = await viewResultAttachment('att-1')
    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when generatePresignedGetUrl throws', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/result.pdf',
      order: { lab: { ownerId: 'lab-owner-1' } },
    })
    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
    const result = await viewResultAttachment('att-1')
    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
  })
})
