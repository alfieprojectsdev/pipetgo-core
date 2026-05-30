/**
 * Unit tests for viewKycDocument server action.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  labDocumentFindUnique: vi.fn(),
  auth: vi.fn(),
  generatePresignedGetUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    labDocument: { findUnique: mocks.labDocumentFindUnique },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('@/lib/storage/r2', () => ({
  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
}))

import { viewKycDocument } from '../view-document-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = {
  user: { id: 'admin-user-1', role: 'ADMIN' },
  expires: '2099-01-01',
}

describe('viewKycDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await viewKycDocument('doc-1')

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labDocumentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })

    const result = await viewKycDocument('doc-1')

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labDocumentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when document not found', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockResolvedValue(null)

    const result = await viewKycDocument('doc-missing')

    expect(result).toEqual({ message: 'Document not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns presigned URL for existing document — generatePresignedGetUrl called with server-fetched r2Key', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockResolvedValue({ r2Key: 'labs/lab-1/doc.pdf' })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')

    const result = await viewKycDocument('doc-1')

    expect(mocks.labDocumentFindUnique).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      select: { r2Key: true },
    })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('labs/lab-1/doc.pdf')
    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
  })
})
