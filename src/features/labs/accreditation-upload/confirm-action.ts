'use server'
// Slice: labs/accreditation-upload. Does not transition kycStatus. See README.md.

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

type ActionState = { message?: string } | null

// Accreditation confirm differs from KYC confirm: it does NOT transition Lab.kycStatus.
// isVerified is the admin-only gate; only the admin verify action sets it to true.
// This action only advances the LabDocument from PENDING to UPLOADED.
export async function confirmUpload(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const labDocumentIdValue = formData.get('labDocumentId')
  const labDocumentId = typeof labDocumentIdValue === 'string' ? labDocumentIdValue : null
  if (!labDocumentId) return { message: 'Missing labDocumentId.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
  if (!lab) return { message: 'No lab found for user.' }

  let updateCount = 0
  await prisma.$transaction(async (tx) => {
    const result = await tx.labDocument.updateMany({
      where: { id: labDocumentId, labId: lab.id, status: 'PENDING' },
      data: { status: 'UPLOADED' },
    })
    updateCount = result.count
  })

  // count===0: doc not found, already UPLOADED, or wrong lab — return early without reporting success.
  if (updateCount === 0) {
    return { message: 'Document not found or already submitted.' }
  }

  revalidatePath('/dashboard/lab/accreditation')

  return null
}
