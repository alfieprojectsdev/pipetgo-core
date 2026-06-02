// Tests for viewOrderAttachment: covers CLIENT role gate, ownership guard,
// type-agnostic access (DL-011), RI violation throw, and presigned GET URL generation. (ref: DL-009, DL-011)

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

import { viewOrderAttachment } from '../view-attachment-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const CLIENT_SESSION = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }

describe('viewOrderAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Unauthorized for non-CLIENT role', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
  })

  it('returns error when attachment not found', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue(null)
    const result = await viewOrderAttachment('att-missing')
    expect(result).toEqual({ message: 'Attachment not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error (not found) when attachment belongs to different client', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/x.pdf',
      order: { clientId: 'other-client' },
    })
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Attachment not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('throws when order relation is null after explicit include (RI violation)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/x.pdf', order: null })
    await expect(viewOrderAttachment('att-1')).rejects.toThrow(/referential integrity violation/i)
  })

  it('returns presigned URL for existing SPECIFICATION attachment owned by client', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/x.pdf',
      order: { clientId: 'client-1' },
    })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')

    const result = await viewOrderAttachment('att-1')

    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
      where:  { id: 'att-1' },
      select: { r2Key: true, order: { select: { clientId: true } } },
    })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/x.pdf', { allowedPrefix: 'orders/' })
    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
  })

  it('returns presigned URL for RESULT attachment owned by same CLIENT (DL-011 — type-agnostic)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/result.pdf',
      order: { clientId: 'client-1' },
    })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/result-url')

    const result = await viewOrderAttachment('att-result-1')

    expect(result).toEqual({ url: 'https://r2.example.com/result-url' })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('orders/ord-1/result.pdf', { allowedPrefix: 'orders/' })
  })

  it('returns error when DB lookup throws', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockRejectedValue(new Error('DB error'))
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when generatePresignedGetUrl throws', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({
      r2Key: 'orders/ord-1/x.pdf',
      order: { clientId: 'client-1' },
    })
    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unable to retrieve attachment.' })
  })
})
