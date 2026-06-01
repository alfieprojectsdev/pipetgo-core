/**
 * Unit tests for confirmUpload server action.
 * Uses full Prisma mock with transaction callback.
 *
 * Key invariant: this action does NOT transition Lab.kycStatus — it advances only
 * LabDocument from PENDING to UPLOADED. Lab.isVerified is set exclusively by the
 * admin accreditation-review action. (ref: T-18 C-002, CI-M-002-002)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  labDocumentUpdateMany: vi.fn(),
  labFindUnique: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const mockTx = {
    labDocument: { updateMany: mocks.labDocumentUpdateMany },
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

// No kycStatus field on MOCK_LAB — this slice must never read or write it.
const MOCK_LAB = { id: 'lab-1', ownerId: 'user-lab-1' }

function makeFormData(labDocumentId = 'doc-1'): FormData {
  const fd = new FormData()
  fd.append('labDocumentId', labDocumentId)
  return fd
}

describe('confirmUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (cb: (tx: { labDocument: { updateMany: Mock } }) => Promise<unknown>) =>
        cb({ labDocument: { updateMany: mocks.labDocumentUpdateMany } }),
    )
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })
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

  it('labDocument.updateMany called with CAS guard {id, labId, status: PENDING}', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    await confirmUpload(null, makeFormData('doc-1'))

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', labId: 'lab-1', status: 'PENDING' },
      data: { status: 'UPLOADED' },
    })
  })

  it('count===0: returns early with error message — document already submitted or wrong lab', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 0 })

    const result = await confirmUpload(null, makeFormData('doc-already-uploaded'))

    expect(result).toEqual({ message: 'Document not found or already submitted.' })
  })

  it('never writes Lab.kycStatus — no lab updateMany call in transaction', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })

    // Only labDocument.updateMany should be called inside the transaction.
    // If the implementation tries to call tx.lab.updateMany it would throw because
    // the mock transaction does not expose a lab property.
    await expect(confirmUpload(null, makeFormData('doc-1'))).resolves.toBeNull()
    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledTimes(1)
  })

  it('never writes Lab.isVerified — no direct lab write on success', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })

    await confirmUpload(null, makeFormData('doc-1'))

    // lab.findUnique is the only lab call — no update, updateMany, or write on Lab.
    expect(mocks.labFindUnique).toHaveBeenCalledTimes(1)
    // Transaction should have been called exactly once.
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })

  it('success: revalidatePath called for accreditation dashboard and returns null', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })

    const result = await confirmUpload(null, makeFormData('doc-1'))

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/lab/accreditation')
    expect(result).toBeNull()
  })

  it('missing labDocumentId returns error without touching prisma', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)

    const fd = new FormData()
    // labDocumentId intentionally omitted
    const result = await confirmUpload(null, fd)

    expect(result).toEqual({ message: 'Missing labDocumentId.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
