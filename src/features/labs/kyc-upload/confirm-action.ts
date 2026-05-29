'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

type ActionState = { message?: string } | null

export async function confirmUpload(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const labDocumentId = formData.get('labDocumentId') as string | null
  if (!labDocumentId) return { message: 'Missing labDocumentId.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
  if (!lab) return { message: 'No lab found for user.' }

  await prisma.$transaction(async (tx) => {
    const docResult = await tx.labDocument.updateMany({
      where: { id: labDocumentId, labId: lab.id, status: 'PENDING' },
      data: { status: 'UPLOADED' },
    })

    if (docResult.count === 0) {
      return
    }

    await tx.lab.updateMany({
      where: { id: lab.id, kycStatus: 'PENDING' },
      data: { kycStatus: 'SUBMITTED' },
    })
  })

  revalidatePath('/dashboard/lab/kyc')

  return null
}
