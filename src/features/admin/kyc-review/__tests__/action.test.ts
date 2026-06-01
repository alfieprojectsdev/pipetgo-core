/**
 * Unit tests for approveOrRejectKyc server action.
 * Uses full Prisma mock with transaction callback.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  labUpdateMany: vi.fn(),
  labDocumentUpdateMany: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const mockTx = {
    lab: { updateMany: mocks.labUpdateMany },
    labDocument: { updateMany: mocks.labDocumentUpdateMany },
  }
  return {
    prisma: {
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

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

import { approveOrRejectKyc } from '../action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const ADMIN_SESSION = {
  user: { id: 'admin-user-1', role: 'ADMIN' },
  expires: '2099-01-01',
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, v)
  }
  return fd
}

describe('approveOrRejectKyc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      (
        cb: (tx: {
          lab: { updateMany: Mock }
          labDocument: { updateMany: Mock }
        }) => Promise<unknown>,
      ) =>
        cb({
          lab: { updateMany: mocks.labUpdateMany },
          labDocument: { updateMany: mocks.labDocumentUpdateMany },
        }),
    )
    mocks.labUpdateMany.mockResolvedValue({ count: 1 })
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 2 })
  })

  it('returns Unauthorized when session is absent — no transaction called', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN — no transaction called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })

    const result = await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns validation error for invalid decision — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'PENDING' }),
    )

    expect(result).toEqual({ message: 'Invalid decision.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error when REJECTED with blank reason — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: '   ' }),
    )

    expect(result).toEqual({ message: 'Rejection reason is required.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('approve SUBMITTED lab — sets APPROVED + audit fields + rejectionReason null + docs VERIFIED', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(mocks.labUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lab-1', kycStatus: 'SUBMITTED' },
      data: expect.objectContaining({
        kycStatus: 'APPROVED',
        kycReviewedById: 'admin-user-1',
        kycRejectionReason: null,
      }),
    })

    const labCall = mocks.labUpdateMany.mock.calls[0][0] as {
      data: { kycReviewedAt: Date }
    }
    expect(labCall.data.kycReviewedAt).toBeInstanceOf(Date)

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { labId: 'lab-1', status: 'UPLOADED', documentType: { in: ['BIR_2303', 'DTI_SEC', 'OTHER'] } },
      data: { status: 'VERIFIED' },
    })
  })

  it('reject with reason — sets REJECTED + reason + docs REJECTED', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Documents unclear' }),
    )

    expect(mocks.labUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lab-1', kycStatus: 'SUBMITTED' },
      data: expect.objectContaining({
        kycStatus: 'REJECTED',
        kycReviewedById: 'admin-user-1',
        kycRejectionReason: 'Documents unclear',
      }),
    })

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { labId: 'lab-1', status: 'UPLOADED', documentType: { in: ['BIR_2303', 'DTI_SEC', 'OTHER'] } },
      data: { status: 'REJECTED' },
    })
  })

  it('CAS count===0 — returns idempotent message and labDocument.updateMany NOT called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labUpdateMany.mockResolvedValue({ count: 0 })

    const result = await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(result).toEqual({
      message: 'Lab is no longer in SUBMITTED status — review may have already been recorded.',
    })
    expect(mocks.labDocumentUpdateMany).not.toHaveBeenCalled()
  })

  it('successful approve — calls revalidatePath and redirect', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await approveOrRejectKyc(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/admin/kyc')
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard/admin/kyc')
  })
})
