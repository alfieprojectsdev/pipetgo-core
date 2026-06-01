'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

type ActionState = { message: string } | null

/**
 * KYC document types. The KYC cascade must be scoped to these so it never advances an
 * ACCREDITATION_CERTIFICATE (or any future LabDocument variety) that coexists in the same
 * table for the lab. Mirrors DOCUMENT_TYPE_ALLOWLIST in labs/kyc-upload/upload-action.ts —
 * kept local rather than imported to respect the VSA slice boundary (ADR-001). (ref: T-18)
 */
const KYC_DOCUMENT_TYPES = ['BIR_2303', 'DTI_SEC', 'OTHER'] as const

/**
 * Approves or rejects a lab's KYC submission.
 *
 * Authorization: role===ADMIN re-checked here independently of the layout guard —
 * Server Actions are POST-invocable without navigating through any page, so the
 * layout guard does not protect them (TOCTOU). (ref: DL-001)
 *
 * State transition: uses tx.lab.updateMany({where:{id, kycStatus:'SUBMITTED'}}) with a
 * count===0 early-return. Two admins reviewing the same lab concurrently: the second
 * write observes count===0 and returns without overwriting the first decision. A bare
 * update() would silently clobber the first decision. (ref: DL-002)
 *
 * Source state: only SUBMITTED is valid. Any other source returns a validation error —
 * unhandled states never default silently. (ref: DL-003)
 *
 * Rejection reason: required when decision===REJECTED; cleared to null on APPROVED.
 * The reason is shown back to the lab on the kyc-upload page. (ref: DL-006)
 *
 * Document cascade: UPLOADED documents for this lab are advanced to VERIFIED or REJECTED
 * in the same $transaction as the kycStatus write, so both states are atomic. (ref: DL-007)
 *
 * redirect() is called after — never inside — the transaction block. (CLAUDE.md)
 */
export async function approveOrRejectKyc(
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
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
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
      const updateResult = await tx.lab.updateMany({
        where: { id: labId, kycStatus: 'SUBMITTED' },
        data: {
          kycStatus: decision,
          kycReviewedById: reviewerId,
          kycReviewedAt: new Date(),
          kycRejectionReason: decision === 'REJECTED' ? reason : null,
        },
      })

      if (updateResult.count === 0) {
        result = { message: 'Lab is no longer in SUBMITTED status — review may have already been recorded.' }
        return
      }

      await tx.labDocument.updateMany({
        where: { labId, status: 'UPLOADED', documentType: { in: [...KYC_DOCUMENT_TYPES] } },
        data: { status: decision === 'APPROVED' ? 'VERIFIED' : 'REJECTED' },
      })

      shouldRedirect = true
    })
  } catch (e) {
    throw new Error(`KYC review transaction failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (result !== null) return result

  revalidatePath('/dashboard/admin/kyc')

  if (shouldRedirect) {
    redirect('/dashboard/admin/kyc')
  }

  return null
}
