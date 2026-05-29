/**
 * Unit tests for confirmUpload server action.
 * Uses full Prisma mock with transaction callback.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  labDocumentUpdateMany: vi.fn(),
  labUpdateMany: vi.fn(),
  labFindUnique: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const mockTx = {
    labDocument: { updateMany: mocks.labDocumentUpdateMany },
    lab: { updateMany: mocks.labUpdateMany },
  }
  return {
    prisma: {
      lab: { findUnique: mocks.labFindUnique },
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

import { confirmUpload } from '../confirm-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const LAB_ADMIN_SESSION = {
  user: { id: 'user-lab-1', role: 'LAB_ADMIN' },
  expires: '2099-01-01',
}

const MOCK_LAB = { id: 'lab-1', ownerId: 'user-lab-1', kycStatus: 'PENDING' }

function makeFormData(labDocumentId = 'doc-1'): FormData {
  const fd = new FormData()
  fd.append('labDocumentId', labDocumentId)
  return fd
}

describe('confirmUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (cb: (tx: { labDocument: { updateMany: Mock }; lab: { updateMany: Mock } }) => Promise<unknown>) =>
        cb({ labDocument: { updateMany: mocks.labDocumentUpdateMany }, lab: { updateMany: mocks.labUpdateMany } }),
    )
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })
    mocks.labUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('returns Unauthorized for non-LAB_ADMIN role, transaction not called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })

    const result = await confirmUpload(null, makeFormData())

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when session is absent, transaction not called', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await confirmUpload(null, makeFormData())

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error when lab not found, transaction not called', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(null)

    const result = await confirmUpload(null, makeFormData())

    expect(result).toEqual({ message: 'No lab found for user.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('labDocument.updateMany called with id, labId, status PENDING guard', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    await confirmUpload(null, makeFormData('doc-1'))

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', labId: 'lab-1', status: 'PENDING' },
      data: { status: 'UPLOADED' },
    })
  })

  it('when updateMany returns count 0, lab.updateMany is NOT called (idempotent)', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 0 })

    const result = await confirmUpload(null, makeFormData('doc-already-uploaded'))

    expect(mocks.labUpdateMany).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('when updateMany returns count 1, lab.updateMany called with id and kycStatus PENDING guard', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })

    await confirmUpload(null, makeFormData('doc-1'))

    expect(mocks.labUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lab-1', kycStatus: 'PENDING' },
      data: { kycStatus: 'SUBMITTED' },
    })
  })

  it('lab.updateMany returning count 0 is success — returns null', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })
    mocks.labUpdateMany.mockResolvedValue({ count: 0 })

    const result = await confirmUpload(null, makeFormData('doc-1'))

    expect(result).toBeNull()
  })

  it('success returns null', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })
    mocks.labUpdateMany.mockResolvedValue({ count: 1 })

    const result = await confirmUpload(null, makeFormData('doc-1'))

    expect(result).toBeNull()
  })
})
