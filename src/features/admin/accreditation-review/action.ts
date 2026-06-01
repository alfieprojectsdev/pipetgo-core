'use server'
// Slice: admin/accreditation-review. See README.md for CAS rationale, cascade scoping,
// and two-layer auth design.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

type ActionState = { message: string } | null

/**
 * Verifies or rejects a lab's ISO 17025 accreditation certificate.
 *
 * Authorization: role===ADMIN re-checked here independently of the layout guard —
 * Server Actions are POST-invocable without navigating through any page. (ref: DL-007)
 *
 * State transition: CAS on isVerified=false — tx.lab.updateMany({where:{id, isVerified:false}}).
 * count===0 means another admin already verified this lab; early-return without overwriting.
 * A bare update() would silently clobber a concurrent verify decision. (ref: DL-004)
 *
 * Rejection: keeps isVerified=false, records accreditationRejectionReason, cascades
 * ACCREDITATION_CERTIFICATE UPLOADED docs to REJECTED (documentType-scoped to avoid
 * clobbering KYC docs coexisting in the same lab). (ref: DL-005)
 *
 * Document cascade is scoped to documentType=ACCREDITATION_CERTIFICATE AND status=UPLOADED
 * because kyc-review's cascade is unscoped ({labId, status:UPLOADED}) — both must not
 * cross-contaminate each other's documents.
 *
 * redirect() is called after — never inside — the transaction block. (CLAUDE.md)
 */
export async function verifyOrRejectAccreditation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const labIdValue = formData.get('labId')
  const decisionValue = formData.get('decision')
  const reasonValue = formData.get('reason')
  const labId = typeof labIdValue === 'string' ? labIdValue : null
  const decision = typeof decisionValue === 'string' ? decisionValue : null
  const reason = typeof reasonValue === 'string' ? reasonValue.trim() : ''

  if (!labId) return { message: 'Missing lab ID.' }
  if (decision !== 'VERIFIED' && decision !== 'REJECTED') {
    return { message: 'Invalid decision.' }
  }
  if (decision === 'REJECTED' && !reason) {
    return { message: 'Rejection reason is required.' }
  }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const reviewerId = session.user.id

  let result: ActionState = null
  let shouldRedirect = false

  try {
    await prisma.$transaction(async (tx) => {
      if (decision === 'VERIFIED') {
        const updateResult = await tx.lab.updateMany({
          where: { id: labId, isVerified: false },
          data: {
            isVerified: true,
            accreditationReviewedById: reviewerId,
            accreditationReviewedAt: new Date(),
            accreditationRejectionReason: null,
          },
        })

        if (updateResult.count === 0) {
          result = { message: 'Lab is already verified — review may have already been recorded.' }
          return
        }

        await tx.labDocument.updateMany({
          where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
          data: { status: 'VERIFIED' },
        })
      } else {
        // Rejection CAS: guard isVerified===false so a reject cannot revert a lab that was
        // concurrently verified by another admin request between the read and this write.
        const rejectResult = await tx.lab.updateMany({
          where: { id: labId, isVerified: false },
          data: {
            isVerified: false,
            accreditationReviewedById: reviewerId,
            accreditationReviewedAt: new Date(),
            accreditationRejectionReason: reason,
          },
        })

        if (rejectResult.count === 0) {
          result = { message: 'Lab is already verified — rejection cannot be applied to a verified lab.' }
          return
        }

        await tx.labDocument.updateMany({
          where: { labId, documentType: 'ACCREDITATION_CERTIFICATE', status: 'UPLOADED' },
          data: { status: 'REJECTED' },
        })
      }

      shouldRedirect = true
    })
  } catch (e) {
    throw new Error(`Accreditation review transaction failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (result !== null) return result

  revalidatePath('/dashboard/admin/accreditation')

  if (shouldRedirect) {
    redirect('/dashboard/admin/accreditation')
  }

  return null
}
