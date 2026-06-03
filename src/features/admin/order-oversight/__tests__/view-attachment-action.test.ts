import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachmentFindUnique: vi.fn(),
  auth: vi.fn(),
  generatePresignedGetUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    attachment: { findUnique: mocks.attachmentFindUnique },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('@/lib/storage/r2', () => ({
  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
}))

import { viewOrderAttachment } from '../view-attachment-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01',
}

describe('viewOrderAttachment (admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent — no query or presign', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
    const result = await viewOrderAttachment('att-1')
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Attachment not found when row is null — no presign', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue(null)
    const result = await viewOrderAttachment('att-missing')
    expect(result).toEqual({ message: 'Attachment not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns presigned URL for existing attachment — findUnique called with correct args', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/file.pdf' })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed')

    const result = await viewOrderAttachment('att-1')

    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      select: { r2Key: true },
    })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith(
      'orders/ord-1/file.pdf',
      { allowedPrefix: 'orders/' },
    )
    expect(result).toEqual({ url: 'https://r2.example.com/signed' })
  })
})
