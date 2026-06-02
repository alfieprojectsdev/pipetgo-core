/**
 * Server Action: viewResultAttachment
 *
 * Mints a 300s presigned R2 GET URL for a RESULT attachment, gated by
 * LAB_ADMIN role and order.lab.ownerId ownership. This action is separate
 * from viewOrderAttachment (spec-upload slice) because the ownership predicate
 * differs: labs verify via ownerId, clients via clientId. Cross-importing
 * between slices is prohibited by ADR-001. (ref: DL-009)
 *
 * A missing lab relation after explicit select is a referential-integrity
 * violation and throws rather than returning notFound(). (ref: DL-009)
 */
'use server'

import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generatePresignedGetUrl } from '@/lib/storage/r2'

type ViewResult = { message: string } | { url: string }

export async function viewResultAttachment(attachmentId: string): Promise<ViewResult> {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  let attachment: { r2Key: string; order: { lab: { ownerId: string } | null } | null } | null
  try {
    attachment = await prisma.attachment.findUnique({
      where:  { id: attachmentId },
      select: {
        r2Key: true,
        order: { select: { lab: { select: { ownerId: true } } } },
      },
    })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  if (!attachment) {
    return { message: 'Attachment not found.' }
  }
  if (!attachment.order) {
    throw new Error(`Attachment ${attachmentId} missing order after explicit include — referential integrity violation`)
  }
  if (!attachment.order.lab) {
    throw new Error(`Attachment ${attachmentId} order missing lab after explicit include — referential integrity violation`)
  }
  if (attachment.order.lab.ownerId !== session.user.id) {
    return { message: 'Attachment not found.' }
  }

  let url: string
  try {
    url = await generatePresignedGetUrl(attachment.r2Key, { allowedPrefix: 'orders/' })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  return { url }
}
