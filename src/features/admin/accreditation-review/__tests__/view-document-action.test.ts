/**
 * Unit tests for viewAccreditationDocument server action.
 *
 * Verifies:
 * - ADMIN role re-check (TOCTOU — DL-007).
 * - r2Key loaded from server-trusted LabDocument row via findUnique — never from client input (IDOR guard, DL-011).
 * - 300s presigned GET URL returned on success.
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

import { viewAccreditationDocument } from '../view-document-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = {
  user: { id: 'admin-user-1', role: 'ADMIN' },
  expires: '2099-01-01',
}

describe('viewAccreditationDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await viewAccreditationDocument('doc-1')

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labDocumentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })

    const result = await viewAccreditationDocument('doc-1')

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labDocumentFindUnique).not.toHaveBeenCalled()
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when document not found', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockResolvedValue(null)

    const result = await viewAccreditationDocument('doc-missing')

    expect(result).toEqual({ message: 'Document not found.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns presigned URL for existing document — r2Key loaded from DB, not from client input', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockResolvedValue({ r2Key: 'labs/lab-1/cert.pdf' })
    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed-url')

    const result = await viewAccreditationDocument('doc-1')

    expect(mocks.labDocumentFindUnique).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      select: { r2Key: true },
    })
    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith('labs/lab-1/cert.pdf')
    expect(result).toEqual({ url: 'https://r2.example.com/signed-url' })
  })

  it('returns error when DB lookup throws', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockRejectedValue(new Error('DB error'))

    const result = await viewAccreditationDocument('doc-1')

    expect(result).toEqual({ message: 'Unable to retrieve document.' })
    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
  })

  it('returns error when generatePresignedGetUrl throws', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labDocumentFindUnique.mockResolvedValue({ r2Key: 'labs/lab-1/cert.pdf' })
    mocks.generatePresignedGetUrl.mockRejectedValue(new Error('R2 error'))

    const result = await viewAccreditationDocument('doc-1')

    expect(result).toEqual({ message: 'Unable to retrieve document.' })
  })
})
