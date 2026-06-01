/**
 * Unit tests for verifyOrRejectAccreditation server action.
 *
 * T-18 invariants verified here:
 * - verifyOrRejectAccreditation writes ONLY isVerified + accreditation audit columns; NEVER kycStatus.
 * - verify path: tx.lab.updateMany({ where: { id, isVerified: false }, data: { isVerified: true, ... } })
 *   with count===0 early-return (concurrent-admin CAS).
 * - reject path: guarded isVerified: false, sets accreditationRejectionReason.
 * - doc cascade: scoped to documentType='ACCREDITATION_CERTIFICATE' AND status='UPLOADED'
 *   so coexisting KYC docs are not touched.
 * - redirect() called AFTER the try/catch block, never inside it.
 *
 * Mock method names align exactly to handler's Prisma calls (CLAUDE.md rollback-test rule).
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

import { verifyOrRejectAccreditation } from '../action'
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

describe('verifyOrRejectAccreditation', () => {
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
    mocks.labDocumentUpdateMany.mockResolvedValue({ count: 1 })
  })

  // --- authorization ---

  it('returns Unauthorized when session is absent — no transaction called', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when role is non-ADMIN — no transaction called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  // --- input validation ---

  it('returns validation error for missing labId — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ decision: 'VERIFIED' }),
    )

    expect(result).toEqual({ message: 'Missing lab ID.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns validation error for invalid decision — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'APPROVED' }),
    )

    expect(result).toEqual({ message: 'Invalid decision.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('returns error when REJECTED with blank reason — no transaction called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: '   ' }),
    )

    expect(result).toEqual({ message: 'Rejection reason is required.' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  // --- verify path ---

  it('verify path — tx.lab.updateMany called with where:{id, isVerified:false} and data:{isVerified:true} + audit + rejectionReason:null', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(mocks.labUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lab-1', isVerified: false },
      data: expect.objectContaining({
        isVerified: true,
        accreditationReviewedById: 'admin-user-1',
        accreditationRejectionReason: null,
      }),
    })

    const labCall = mocks.labUpdateMany.mock.calls[0][0] as {
      data: { accreditationReviewedAt: Date }
    }
    expect(labCall.data.accreditationReviewedAt).toBeInstanceOf(Date)
  })

  it('verify path — T-18 invariant: kycStatus is never written', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    const labCall = mocks.labUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(labCall.data).not.toHaveProperty('kycStatus')
  })

  it('verify path — doc cascade scoped to documentType=ACCREDITATION_CERTIFICATE AND status=UPLOADED, sets VERIFIED', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { labId: 'lab-1', documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
      data: { status: 'VERIFIED' },
    })
  })

  it('verify path — doc cascade does not include an unscoped where (KYC docs must not be touched)', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    const docCall = mocks.labDocumentUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>
    }
    // documentType filter must be present — absence would clobber KYC docs
    expect(docCall.where).toHaveProperty('documentType', 'ACCREDITATION_CERTIFICATE')
    // status filter must be UPLOADED — not absent and not a different value
    expect(docCall.where).toHaveProperty('status', 'UPLOADED')
  })

  // --- verify CAS (concurrent-admin) ---

  it('verify CAS count===0 — returns idempotent message and labDocument.updateMany NOT called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labUpdateMany.mockResolvedValue({ count: 0 })

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(result).toEqual({
      message: 'Lab is already verified — review may have already been recorded.',
    })
    expect(mocks.labDocumentUpdateMany).not.toHaveBeenCalled()
  })

  // --- reject path ---

  it('reject path — tx.lab.updateMany called with where:{id, isVerified:false} and data:{isVerified:false, accreditationRejectionReason}', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Certificate expired' }),
    )

    expect(mocks.labUpdateMany).toHaveBeenCalledWith({
      where: { id: 'lab-1', isVerified: false },
      data: expect.objectContaining({
        isVerified: false,
        accreditationReviewedById: 'admin-user-1',
        accreditationRejectionReason: 'Certificate expired',
      }),
    })
  })

  it('reject path — T-18 invariant: kycStatus is never written', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Certificate expired' }),
    )

    const labCall = mocks.labUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(labCall.data).not.toHaveProperty('kycStatus')
  })

  it('reject path — doc cascade scoped to documentType=ACCREDITATION_CERTIFICATE AND status=UPLOADED, sets REJECTED', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Certificate expired' }),
    )

    expect(mocks.labDocumentUpdateMany).toHaveBeenCalledWith({
      where: { labId: 'lab-1', documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
      data: { status: 'REJECTED' },
    })
  })

  it('reject CAS count===0 (lab was concurrently verified) — returns message and labDocument.updateMany NOT called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.labUpdateMany.mockResolvedValue({ count: 0 })

    const result = await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Certificate expired' }),
    )

    expect(result).toEqual({
      message: 'Lab is already verified — rejection cannot be applied to a verified lab.',
    })
    expect(mocks.labDocumentUpdateMany).not.toHaveBeenCalled()
  })

  // --- redirect-after-try/catch ---

  it('successful verify — calls revalidatePath and redirect AFTER the transaction', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
    )

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/admin/accreditation')
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard/admin/accreditation')
  })

  it('successful reject — calls revalidatePath and redirect AFTER the transaction', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)

    await verifyOrRejectAccreditation(
      null,
      makeFormData({ labId: 'lab-1', decision: 'REJECTED', reason: 'Expired cert' }),
    )

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/admin/accreditation')
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard/admin/accreditation')
  })

  // --- rollback propagation ---

  it('transaction error is rethrown — redirect NOT called', async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION)
    mocks.transaction.mockRejectedValue(new Error('DB connection lost'))

    await expect(
      verifyOrRejectAccreditation(
        null,
        makeFormData({ labId: 'lab-1', decision: 'VERIFIED' }),
      ),
    ).rejects.toThrow('Accreditation review transaction failed: DB connection lost')

    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
